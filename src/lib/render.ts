import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { runOrThrow, type RunOptions } from './bin'
import { selectExpr } from './cut'
import { fontsDir, mediaRoot } from './paths'
import type { ReframeMode } from './types'

export const OUT_WIDTH = 1080
export const OUT_HEIGHT = 1920

export interface Probe {
  width: number
  height: number
  duration: number
  hasAudio: boolean
}

export function probeArgs(path: string): string[] {
  return [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,width,height:format=duration',
    '-of',
    'json',
    path,
  ]
}

export function parseProbe(json: string): Probe {
  let doc: {
    streams?: Array<Record<string, unknown>>
    format?: Record<string, unknown>
  }
  try {
    doc = JSON.parse(json) as typeof doc
  } catch {
    throw new Error('ffprobe returned something that is not JSON')
  }

  const streams = doc.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video')

  return {
    width: Number(video?.width) || 0,
    height: Number(video?.height) || 0,
    duration: Number(doc.format?.duration) || 0,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
  }
}

export async function probe(path: string, opts: RunOptions = {}): Promise<Probe> {
  const result = await runOrThrow('ffprobe', probeArgs(path), opts)
  return parseProbe(result.stdout)
}

export interface Rect {
  w: number
  h: number
  x: number
  y: number
}

/**
 * The 9:16 window to take out of a landscape frame.
 *
 * `focus` runs −1 (hard left) to 0 (centre) to 1 (hard right). There is no
 * face detection behind it — this is a slider a person moves, and saying so is
 * more useful than pretending the crop is smart.
 *
 * Every value is forced even because H.264's chroma planes are half-resolution
 * and libx264 refuses an odd dimension outright.
 */
export function cropRect(width: number, height: number, focus: number): Rect {
  // A dimension rounds *down* so the crop can never ask for a pixel the source
  // does not have. An offset rounds down to zero, because hard-left is a real
  // answer — giving offsets the same floor of 2 as dimensions was what stopped
  // focus −1 from actually reaching the left edge.
  const size = (n: number): number => Math.max(2, Math.floor(n / 2) * 2)
  const offset = (n: number): number => Math.max(0, Math.floor(n / 2) * 2)

  const clamped = Math.min(1, Math.max(-1, focus))
  const targetAspect = OUT_WIDTH / OUT_HEIGHT

  if (width / height > targetAspect) {
    // Wider than 9:16 — the usual case. Take a full-height slice.
    const h = size(height)
    const w = Math.min(size(width), size(h * targetAspect))
    const room = width - w
    return { w, h, x: Math.min(offset((room * (clamped + 1)) / 2), room), y: 0 }
  }

  // Already tall — take a full-width slice, anchored slightly above centre
  // because that is where faces are.
  const w = size(width)
  const h = Math.min(size(height), size(w / targetAspect))
  const room = height - h
  return { w, h, x: 0, y: Math.min(offset(room * 0.35), room) }
}

/**
 * The 9:16 window, chosen inside the active picture rather than inside the
 * whole frame — so a source carrying its own letterbox is cropped past the
 * bars instead of through them.
 */
export function focusCrop(content: Rect, focus: number): Rect {
  const rect = cropRect(content.w, content.h, focus)
  return { ...rect, x: content.x + rect.x, y: content.y + rect.y }
}

export interface CropShot {
  from: number
  x: number
  y: number
}

export interface CropPlan {
  w: number
  h: number
  shots: CropShot[]
  content: Rect
}

/**
 * One crop coordinate, as a function of time.
 *
 * A single number when the framing never moves. Otherwise a chain of `if`s on
 * `t`, which is how a crop follows an interview that cuts between two people
 * without re-encoding the clip once per shot.
 *
 * Commas are escaped because ffmpeg's filter parser reads an unescaped one as
 * the end of this filter — the resulting graph is not invalid, it is a
 * *different* graph, which is the worst kind of bug to find. They must not
 * also be quoted; doing both leaves literal backslashes in the expression.
 */
export function cropCoordExpr(shots: CropShot[], axis: 'x' | 'y'): string {
  if (shots.length === 0) return '0'
  if (shots.length === 1) return String(shots[0][axis])

  let expr = String(shots[shots.length - 1][axis])
  for (let i = shots.length - 2; i >= 0; i--) {
    expr = `if(lt(t\\,${shots[i + 1].from.toFixed(3)})\\,${shots[i][axis]}\\,${expr})`
  }
  return expr
}

export interface RenderSpec {
  /** Relative to the working directory the render runs in. */
  input: string
  output: string
  start: number
  duration: number
  reframe: ReframeMode
  focus: number
  sourceWidth: number
  sourceHeight: number
  /**
   * Where to crop, shot by shot. The size is fixed for the clip — a crop whose
   * dimensions changed part-way through is not a video — and only the origin
   * moves.
   */
  crop?: CropPlan
  /**
   * Source ranges to keep, relative to `start`. More than one means dead air
   * is being spliced out and the graph needs `select`.
   */
  keep?: Array<{ from: number; to: number }>
  hasAudio: boolean
  /** Relative path to the .ass file, or null for no captions. */
  captions: string | null
  /** Relative path to the bundled fonts. */
  fontsDir: string
}

/**
 * The video filter chain.
 *
 * `crop` is the honest default. `blur` fits the whole frame over a blown-up,
 * blurred copy of itself — which loses nothing from the sides and is the right
 * answer for anything with slides, charts or two people on screen.
 *
 * Captions are burned in last, after the frame is its final size, so the
 * caption is sized against the output rather than scaled along with the video.
 */
export function filterChain(spec: RenderSpec): string {
  const plan: CropPlan = spec.crop ?? defaultCrop(spec)
  const steps: string[] = []

  // 1. Frame first. The crop expression is written against `t`, which at this
  //    point is still the source clock the shots were measured on.
  if (spec.reframe === 'crop') {
    steps.push(
      `crop=w=${plan.w}:h=${plan.h}` +
        `:x=${cropCoordExpr(plan.shots, 'x')}` +
        `:y=${cropCoordExpr(plan.shots, 'y')}`,
    )
  } else if (
    // Blur and 16:9 keep the whole picture, but still drop any letterbox the
    // source carried.
    plan.content.x !== 0 ||
    plan.content.y !== 0 ||
    plan.content.w !== spec.sourceWidth ||
    plan.content.h !== spec.sourceHeight
  ) {
    steps.push(
      `crop=${plan.content.w}:${plan.content.h}:${plan.content.x}:${plan.content.y}`,
    )
  }

  // 2. Drop the dead air, then restamp so the clip runs continuously.
  if (spec.keep && spec.keep.length > 1) {
    // Not quoted: `selectExpr` already escapes its commas, and doing both
    // leaves literal backslashes inside the expression — ffmpeg then rejects
    // the whole graph with "Error opening output files: Invalid argument".
    steps.push(`select=${selectExpr(spec.keep, 0)}`, 'setpts=N/FRAME_RATE/TB')
  }

  // 3. Reach the output size.
  if (spec.reframe === 'blur') {
    const head = steps.length ? `[0:v]${steps.join(',')}[src];[src]` : '[0:v]'
    return (
      `${head}split=2[base][top];` +
      `[base]scale=${OUT_WIDTH}:${OUT_HEIGHT}:force_original_aspect_ratio=increase,` +
      `crop=${OUT_WIDTH}:${OUT_HEIGHT},boxblur=luma_radius=30:luma_power=2,` +
      `eq=brightness=-0.12:saturation=0.7[bg];` +
      // `decrease` rather than a fixed height: a source that is already tall
      // would otherwise be scaled past the frame and silently cropped by the
      // overlay.
      `[top]scale=${OUT_WIDTH}:${OUT_HEIGHT}:force_original_aspect_ratio=decrease:flags=lanczos[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,${tailOf(spec)}[v]`
    )
  }

  if (spec.reframe === 'crop') {
    steps.push(`scale=${OUT_WIDTH}:${OUT_HEIGHT}:flags=lanczos`)
  } else {
    // Untouched 16:9 — still normalised to even dimensions, because an odd one
    // is rejected outright by libx264.
    steps.push('scale=trunc(iw/2)*2:trunc(ih/2)*2')
  }

  steps.push(tailOf(spec))
  return `[0:v]${steps.join(',')}[v]`
}

/** A plain centre crop, for a spec that was never given a framing plan. */
function defaultCrop(spec: RenderSpec): CropPlan {
  const rect = cropRect(spec.sourceWidth, spec.sourceHeight, spec.focus)
  return {
    w: rect.w,
    h: rect.h,
    shots: [{ from: 0, x: rect.x, y: rect.y }],
    content: { x: 0, y: 0, w: spec.sourceWidth, h: spec.sourceHeight },
  }
}

/** Pixel format, then captions — both always last, on the finished frame. */
function tailOf(spec: RenderSpec): string {
  return ['format=yuv420p', ...(spec.captions ? [subtitlesFilter(spec)] : [])].join(',')
}

/** The audio side of a spliced cut, which has to drop exactly the same ranges. */
export function audioFilter(spec: RenderSpec): string[] {
  const spliced = spec.keep && spec.keep.length > 1
  const steps = [
    ...(spliced ? [`aselect=${selectExpr(spec.keep!, 0)}`, 'asetpts=N/SR/TB'] : []),
    // Every platform normalises loudness on upload anyway; matching the
    // target they use means the clip is not quietly turned down later.
    'loudnorm=I=-16:TP=-1.5:LRA=11',
  ]
  return ['-af', steps.join(',')]
}

/**
 * ffmpeg's filter syntax treats `:` as an argument separator and `\` as an
 * escape, so an absolute path with a space or a colon in it breaks the whole
 * graph in a way the error message does not explain.
 *
 * Rather than layering escapes, the render runs with its working directory set
 * to the job's own folder and every path here is a short relative one with no
 * special characters in it — see `stageFonts`.
 */
function subtitlesFilter(spec: RenderSpec): string {
  return `subtitles=${spec.captions}:fontsdir=${spec.fontsDir}`
}

/**
 * Seeking before `-i` rather than after.
 *
 * After the input, ffmpeg decodes and throws away everything up to the start
 * point — on a 40-minute source, cutting a clip from the last five minutes
 * takes almost as long as decoding the whole video. Before the input it seeks
 * to the nearest keyframe first, and because the output is re-encoded anyway
 * the result is still frame-accurate.
 */
export function ffmpegArgs(spec: RenderSpec): string[] {
  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-ss',
    spec.start.toFixed(3),
    '-i',
    spec.input,
    '-t',
    spec.duration.toFixed(3),
    // `-filter_complex` rather than `-vf`, for every mode rather than only the
    // one that needs it. `-vf` takes a single linear chain, so the blur graph
    // — which splits the frame in two and overlays it on itself — was rejected
    // outright with "Error opening output files: Invalid argument". Using one
    // form everywhere means the three modes cannot diverge in how they fail.
    '-filter_complex',
    filterChain(spec),
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
  ]

  if (spec.hasAudio) {
    args.push(
      // Mapping the audio explicitly, because naming a video output above
      // turns off ffmpeg's automatic stream selection entirely — without this
      // every clip comes out silent.
      '-map',
      '0:a:0',
      ...audioFilter(spec),
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-ar',
      '48000',
      '-ac',
      '2',
    )
  } else {
    args.push('-an')
  }

  args.push('-movflags', '+faststart', '-progress', 'pipe:2', spec.output)
  return args
}

/** Seconds rendered so far, from an `out_time_ms=` line of `-progress`. */
export function parseRenderProgress(line: string): number | null {
  const micro = line.match(/^out_time_ms=(\d+)/)
  if (micro) return Number(micro[1]) / 1_000_000

  const stamp = line.match(/^out_time=(\d+):(\d{2}):(\d{2})/)
  if (stamp) {
    return Number(stamp[1]) * 3600 + Number(stamp[2]) * 60 + Number(stamp[3])
  }

  return null
}

export async function render(
  spec: RenderSpec,
  cwd: string,
  opts: RunOptions & { onProgress?: (pct: number) => void } = {},
): Promise<void> {
  await runOrThrow('ffmpeg', ffmpegArgs(spec), {
    ...opts,
    cwd,
    onLine: (line) => {
      const seconds = parseRenderProgress(line)
      if (seconds !== null && spec.duration > 0 && opts.onProgress) {
        opts.onProgress(Math.min(100, (seconds / spec.duration) * 100))
      }
      opts.onLine?.(line)
    },
  })
}

/** 16 kHz mono is what Whisper resamples to anyway; doing it here is faster. */
export function audioArgs(input: string, output: string): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    input,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    output,
  ]
}

export function thumbnailArgs(input: string, output: string, at: number): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-ss',
    at.toFixed(3),
    '-i',
    input,
    '-frames:v',
    '1',
    '-q:v',
    '4',
    output,
  ]
}

/**
 * Put the caption fonts somewhere with a boring path.
 *
 * The repo lives wherever the user cloned it, which on a Mac is frequently
 * under a directory with a space in it — and a space, a colon or an apostrophe
 * in a `fontsdir=` argument breaks ffmpeg's filter parser. Copying the fonts
 * once to `<media>/fonts` means every render can refer to them as `../fonts`,
 * which needs no escaping at all.
 */
export async function stageFonts(): Promise<void> {
  const target = join(mediaRoot(), 'fonts')
  await mkdir(target, { recursive: true })

  const source = fontsDir()
  const files = await readdir(source).catch(() => [] as string[])

  await Promise.all(
    files
      .filter((f) => /\.(ttf|otf)$/i.test(f))
      .map((f) => copyFile(join(source, f), join(target, f)).catch(() => undefined)),
  )
}
