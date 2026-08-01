import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { runOrThrow, type RunOptions } from './bin'
import { cropRect, OUT_HEIGHT, OUT_WIDTH } from './render'

/**
 * Where in the frame to point a 9:16 crop.
 *
 * This is not face detection and does not pretend to be. It samples a handful
 * of frames at postage-stamp size, measures which columns of the picture are
 * *moving* and which carry *detail*, and centres the crop on the busiest band.
 *
 * On the shot that prompted it — a side-by-side interview, two Zoom windows
 * with black bars, one person talking — a centre crop lands squarely on the
 * seam between them. Motion picks the person who is speaking, because a
 * talking head moves and a bookshelf does not.
 *
 * Everything here is arithmetic over a byte array, so it is fast, it is
 * testable, and when it has nothing to go on it returns 0 and the crop is
 * centred exactly as it was before.
 */

/** Frames are sampled this wide; height follows the source aspect. */
export const SAMPLE_WIDTH = 96
export const SAMPLE_HEIGHT = 54
/** Frames per second sampled. Two is enough to see a mouth move. */
export const SAMPLE_FPS = 2
/** No more than this many frames, however long the clip. */
export const MAX_SAMPLES = 24
/**
 * A row or column is picture once this share of it is above the dark level.
 * Low enough for a dim shot, high enough that a logo in the letterbox does not
 * rescue the whole bar.
 */
export const MIN_PICTURE_SHARE = 0.08

/**
 * Frames per second to sample so the whole clip is covered by `MAX_SAMPLES`.
 *
 * Sampling a fixed window off the front was the obvious thing and it is wrong:
 * a clip that opens on a letterboxed Zoom tile and cuts to a full-frame shot
 * had its framing decided entirely by the first twelve seconds, and every shot
 * after that inherited it.
 */
export function sampleFps(duration: number): number {
  if (duration <= 0) return SAMPLE_FPS
  return Math.min(SAMPLE_FPS, Math.max(0.2, MAX_SAMPLES / duration))
}

export function sampleArgs(
  input: string,
  output: string,
  start: number,
  duration: number,
): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-ss',
    start.toFixed(3),
    '-i',
    input,
    '-t',
    duration.toFixed(3),
    '-vf',
    `fps=${sampleFps(duration).toFixed(4)},scale=${SAMPLE_WIDTH}:${SAMPLE_HEIGHT},format=gray`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    output,
  ]
}

/** Split a rawvideo blob into one plane per frame. */
export function toFrames(
  raw: Uint8Array,
  width = SAMPLE_WIDTH,
  height = SAMPLE_HEIGHT,
): Uint8Array[] {
  const size = width * height
  const count = Math.floor(raw.length / size)

  const frames: Uint8Array[] = []
  for (let i = 0; i < count; i++) {
    frames.push(raw.subarray(i * size, (i + 1) * size))
  }
  return frames
}

/**
 * How interesting each column of the picture is.
 *
 * Two signals, because either alone picks the wrong thing:
 *
 *   - **Motion** — how much a column changes between frames. This is what
 *     finds the person speaking, and on its own it would happily centre on a
 *     flickering light or a caption burned into the source.
 *   - **Detail** — how much the column varies within a frame. This is what
 *     separates a face from a blank wall, and on its own it would centre on a
 *     bookshelf and ignore the human in front of it.
 *
 * Both are normalised before mixing, so a nearly static shot still produces a
 * usable detail signal rather than being swamped by motion noise.
 */
export function columnActivity(
  frames: Uint8Array[],
  width = SAMPLE_WIDTH,
  height = SAMPLE_HEIGHT,
): number[] {
  const motion = new Array<number>(width).fill(0)
  const detail = new Array<number>(width).fill(0)

  if (frames.length === 0) return motion

  for (let f = 0; f < frames.length; f++) {
    const frame = frames[f]
    const previous = f > 0 ? frames[f - 1] : null

    for (let y = 0; y < height; y++) {
      const row = y * width
      for (let x = 0; x < width; x++) {
        const value = frame[row + x]

        if (previous) motion[x] += Math.abs(value - previous[row + x])
        if (x > 0) detail[x] += Math.abs(value - frame[row + x - 1])
      }
    }
  }

  const normalise = (values: number[]): number[] => {
    const max = Math.max(...values)
    return max > 0 ? values.map((v) => v / max) : values.map(() => 0)
  }

  const m = normalise(motion)
  const d = normalise(detail)

  return m.map((value, i) => value * 0.65 + d[i] * 0.35)
}

/**
 * The focus offset whose crop window covers the most activity.
 *
 * A gentle pull towards the centre breaks ties and stops a marginally busier
 * edge from yanking the frame sideways on an otherwise centred shot — the
 * difference between "it found the speaker" and "it wanders".
 */
export function bestFocus(
  activity: number[],
  sourceWidth: number,
  sourceHeight: number,
  centreBias = 0.25,
): number {
  const columns = activity.length
  if (columns === 0) return 0

  const rect = cropRect(sourceWidth, sourceHeight, 0)
  const windowWidth = Math.max(1, Math.round((rect.w / sourceWidth) * columns))

  // The crop already covers the whole width; there is nothing to choose.
  if (windowWidth >= columns) return 0

  const total = activity.reduce((a, b) => a + b, 0)
  if (total <= 0) return 0

  // The bias is scaled by the *average* activity rather than applied flat.
  // Flat, it beat the signal: on a side-by-side interview both people are
  // busy, the middle is a dip between them, and a fixed pull to the centre
  // parked the crop squarely on the seam. Relative, a clear subject wins and
  // a genuinely even frame still settles in the middle.
  const mean = total / columns

  // Prefix sums, so every candidate window costs one subtraction.
  const prefix = new Array<number>(columns + 1).fill(0)
  for (let i = 0; i < columns; i++) prefix[i + 1] = prefix[i] + activity[i]

  const room = columns - windowWidth
  let bestScore = -Infinity
  let bestOffset = room / 2

  for (let offset = 0; offset <= room; offset++) {
    const covered = prefix[offset + windowWidth] - prefix[offset]
    const focus = room === 0 ? 0 : (offset / room) * 2 - 1
    const score = covered / windowWidth - centreBias * Math.abs(focus) * mean

    if (score > bestScore) {
      bestScore = score
      bestOffset = offset
    }
  }

  const focus = room === 0 ? 0 : (bestOffset / room) * 2 - 1
  return Math.max(-1, Math.min(1, Number(focus.toFixed(3))))
}

export interface ContentRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * The part of the frame that is actually picture.
 *
 * A video of a video — a Zoom tile, a screen recording, an old 4:3 upload —
 * carries its own black bars, and a 9:16 crop taken from the middle of it
 * inherits them. On a real run this was the worst-looking thing the tool
 * produced: two clips whose subject sat in a letterboxed band with black above
 * and below.
 *
 * `cropdetect` cannot help here. On a side-by-side interview the two tiles
 * together fill the frame, so the bars are *inside* each half and the whole
 * frame reads as active. Working from the sampled columns and rows instead
 * finds them, because the sample already knows which columns the subject is in.
 *
 * Nothing is trimmed past `maxTrim` of a side: a genuinely dark shot is not a
 * letterbox, and cropping half the picture off a night scene would be worse
 * than the problem.
 */
export function contentRect(
  frames: Uint8Array[],
  sourceWidth: number,
  sourceHeight: number,
  width = SAMPLE_WIDTH,
  height = SAMPLE_HEIGHT,
  darkLevel = 26,
  maxTrim = 0.35,
): ContentRect {
  const whole: ContentRect = { x: 0, y: 0, w: sourceWidth, h: sourceHeight }
  if (frames.length === 0) return whole

  // The *share* of each row and column that is bright, at its best across the
  // clip — not the peak brightness. Peak fails on the thing that actually
  // occurs: a channel watermark sitting inside the letterbox. One bright logo
  // made a whole bar read as picture, and the bar shipped in the clip.
  const rowShare = new Array<number>(height).fill(0)
  const colShare = new Array<number>(width).fill(0)

  for (const frame of frames) {
    const rowHits = new Array<number>(height).fill(0)
    const colHits = new Array<number>(width).fill(0)

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (frame[y * width + x] > darkLevel) {
          rowHits[y]++
          colHits[x]++
        }
      }
    }

    for (let y = 0; y < height; y++) {
      rowShare[y] = Math.max(rowShare[y], rowHits[y] / width)
    }
    for (let x = 0; x < width; x++) {
      colShare[x] = Math.max(colShare[x], colHits[x] / height)
    }
  }

  const edge = (shares: number[], limit: number): [number, number] => {
    let lo = 0
    let hi = shares.length - 1
    while (lo < shares.length && shares[lo] < MIN_PICTURE_SHARE) lo++
    while (hi > lo && shares[hi] < MIN_PICTURE_SHARE) hi--

    // Refuse to take more than the cap off either side.
    const cap = Math.floor(shares.length * limit)
    return [Math.min(lo, cap), Math.max(hi, shares.length - 1 - cap)]
  }

  const [top, bottom] = edge(rowShare, maxTrim)
  const [left, right] = edge(colShare, maxTrim)

  if (bottom <= top || right <= left) return whole

  // A size can never be zero; an offset can, and forcing it to 2 shaves a
  // sliver off all four sides of a frame that needed no trimming at all.
  const evenSize = (n: number): number => Math.max(2, Math.floor(n / 2) * 2)
  const evenOffset = (n: number): number => Math.max(0, Math.floor(n / 2) * 2)

  const scaleX = sourceWidth / width
  const scaleY = sourceHeight / height

  const x = evenOffset(left * scaleX)
  const y = evenOffset(top * scaleY)
  const right2 = Math.min(sourceWidth, Math.ceil((right + 1) * scaleX))
  const bottom2 = Math.min(sourceHeight, Math.ceil((bottom + 1) * scaleY))

  return {
    x,
    y,
    w: Math.min(evenSize(right2 - x), sourceWidth - x),
    h: Math.min(evenSize(bottom2 - y), sourceHeight - y),
  }
}

/**
 * Where the picture cuts to a different shot.
 *
 * One focus offset for a whole clip is wrong the moment an interview cuts
 * between two people. Frames either side of a cut disagree far more than
 * frames within a shot do, so a spike in total difference is a cut — and a
 * threshold set from the clip's own median keeps that true for a static talk
 * and a busy edit alike.
 *
 * Returns the index of the first frame of each shot, always starting at 0.
 */
export function shotBoundaries(
  frames: Uint8Array[],
  fps = SAMPLE_FPS,
  minSeconds = 1.2,
  sensitivity = 3.2,
): number[] {
  // In frames, not seconds — but derived from seconds, because the sample
  // rate now varies with clip length. Fixed at three frames it meant five
  // seconds on a long clip, which silently merged every short opening shot
  // into the one after it and framed both by the wrong one.
  const minFramesPerShot = Math.max(1, Math.round(minSeconds * fps))

  if (frames.length < 2) return [0]

  const diffs: number[] = []
  for (let i = 1; i < frames.length; i++) {
    let total = 0
    for (let p = 0; p < frames[i].length; p++) {
      total += Math.abs(frames[i][p] - frames[i - 1][p])
    }
    diffs.push(total / frames[i].length)
  }

  const sorted = [...diffs].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  // A floor, so a completely still shot does not turn every flicker into a cut.
  const threshold = Math.max(median * sensitivity, 12)

  const shots = [0]
  for (let i = 0; i < diffs.length; i++) {
    const frame = i + 1
    if (diffs[i] < threshold) continue
    if (frame - shots[shots.length - 1] < minFramesPerShot) continue
    shots.push(frame)
  }

  return shots
}

export interface CropShot {
  /** Seconds from the clip start. */
  from: number
  /** Absolute crop origin in source pixels. */
  x: number
  y: number
}

export interface CropPlan {
  /** Fixed for the whole clip — a crop whose size changed would be invalid. */
  w: number
  h: number
  shots: CropShot[]
  /**
   * The picture area of the opening shot. Blur fit and 16:9 keep the whole
   * frame rather than cropping to 9:16, but they still want the source's own
   * letterbox gone.
   */
  content: ContentRect
}

/**
 * Where to put the crop, shot by shot.
 *
 * The size is fixed and the origin moves, because `crop` can take an
 * expression for x and y but not for width and height — an output whose frame
 * size changed part-way through is not a video.
 *
 * The size comes from the *smallest* picture any shot offers, so a clip that
 * opens letterboxed and cuts to full frame never shows a bar: the full-frame
 * shots are simply framed a little tighter, which for a short is an
 * improvement rather than a cost.
 */
export function planCrop(
  frames: Uint8Array[],
  sourceWidth: number,
  sourceHeight: number,
  fps = SAMPLE_FPS,
): CropPlan {
  const fallback = cropRect(sourceWidth, sourceHeight, 0)
  const whole: CropPlan = {
    w: fallback.w,
    h: fallback.h,
    shots: [{ from: 0, x: fallback.x, y: fallback.y }],
    content: { x: 0, y: 0, w: sourceWidth, h: sourceHeight },
  }

  if (frames.length === 0) return whole

  const bounds = shotBoundaries(frames, fps)
  const shots = bounds.map((start, i) => {
    const end = i + 1 < bounds.length ? bounds[i + 1] : frames.length
    const slice = frames.slice(start, end)
    return {
      start,
      slice,
      content: contentRect(slice, sourceWidth, sourceHeight),
    }
  })

  /**
   * One size for the clip, taken from the shot it spends most time in.
   *
   * Sizing to the *tightest* shot was tried first and is worse: a two-second
   * picture-in-picture at the top of a clip has a small inset, and letting it
   * choose meant the following forty seconds were cropped to a face with the
   * top of the head cut off. The shot most of the clip actually is, is the one
   * worth framing for — an outlier shot may show a sliver of its own bar, and
   * that is a better trade than mis-framing the whole clip.
   */
  const dominant = shots.reduce((best, shot) =>
    shot.slice.length > best.slice.length ? shot : best,
  )
  const target = cropRect(dominant.content.w, dominant.content.h, 0)

  const placed: CropShot[] = []

  for (const shot of shots) {
    const focus = bestFocus(columnActivity(shot.slice), shot.content.w, shot.content.h)

    const room = Math.max(0, shot.content.w - target.w)
    const x = shot.content.x + Math.round((room * (Math.min(1, Math.max(-1, focus)) + 1)) / 2)

    // Slightly above centre within the shot's own picture, where faces are.
    // A shot whose picture is shorter than the crop cannot avoid its bars, so
    // it is centred on its own content rather than pinned to the top of it.
    const spare = shot.content.h - target.h
    const y =
      spare >= 0
        ? shot.content.y + Math.round(spare * 0.4)
        : shot.content.y + Math.round(spare / 2)

    const even = (n: number): number => Math.max(0, Math.floor(n / 2) * 2)
    const next: CropShot = {
      from: shot.start / fps,
      x: Math.min(even(x), sourceWidth - target.w),
      y: Math.min(even(y), sourceHeight - target.h),
    }

    const previous = placed[placed.length - 1]
    // A shot that would move the crop by a few pixels is not worth a jump.
    if (previous && Math.abs(previous.x - next.x) < 24 && Math.abs(previous.y - next.y) < 24) {
      continue
    }
    placed.push(next)
  }

  if (placed.length === 0) return whole
  if (placed[0].from > 0) placed[0] = { ...placed[0], from: 0 }

  return { w: target.w, h: target.h, shots: placed, content: shots[0].content }
}

export interface Framing {
  /** Fixed crop size, and where it sits at each shot. */
  crop: CropPlan
}

/**
 * Look at the clip and decide how to frame it.
 *
 * One ffmpeg pass yields everything: the sampled frames answer where the
 * picture actually is, where the subject is within it, and where the shot
 * changes. Returns a plain centre crop for any failure at all — framing that
 * is merely un-clever is fine, a render that dies because a byte array would
 * not parse is not.
 */
export async function analyseFraming(
  input: string,
  dir: string,
  start: number,
  duration: number,
  sourceWidth: number,
  sourceHeight: number,
  opts: RunOptions = {},
): Promise<Framing> {
  const fallback = cropRect(sourceWidth, sourceHeight, 0)
  const whole: Framing = {
    crop: {
      w: fallback.w,
      h: fallback.h,
      shots: [{ from: 0, x: fallback.x, y: fallback.y }],
      content: { x: 0, y: 0, w: sourceWidth, h: sourceHeight },
    },
  }

  const sampleFile = `focus-${Math.round(start * 1000)}.raw`
  const samplePath = join(dir, sampleFile)

  try {
    await runOrThrow('ffmpeg', sampleArgs(input, sampleFile, start, duration), {
      ...opts,
      cwd: dir,
    })

    const raw = await readFile(samplePath)
    const frames = toFrames(new Uint8Array(raw))
    if (frames.length < 2) return whole

    return {
      crop: planCrop(frames, sourceWidth, sourceHeight, sampleFps(duration)),
    }
  } catch {
    return whole
  } finally {
    await unlink(samplePath).catch(() => undefined)
  }
}
