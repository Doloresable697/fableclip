import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, copyFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run, runOrThrow } from '@/lib/bin'
import { buildAss, PRESETS } from '@/lib/ass'
import { cropRect, ffmpegArgs, parseProbe, probeArgs, type RenderSpec } from '@/lib/render'
import type { Word } from '@/lib/types'

/**
 * The one test that runs the real thing.
 *
 * Everything else in this suite checks the arguments handed to ffmpeg. That
 * catches a wrong flag and cannot catch the failure that actually matters: a
 * filter graph ffmpeg rejects, a caption file libass silently ignores, an
 * output no player will open. So this builds a source with ffmpeg, renders a
 * clip through the real pipeline, and looks at the file that comes out.
 *
 * It needs ffmpeg on PATH — which the container always has — and skips itself
 * rather than failing when run somewhere that does not.
 */
const has = async (tool: 'ffmpeg' | 'ffprobe'): Promise<boolean> => {
  try {
    await run(tool, ['-version'])
    return true
  } catch {
    return false
  }
}

const SOURCE_SECONDS = 12
const available = (await has('ffmpeg')) && (await has('ffprobe'))

describe.skipIf(!available)('rendering a real clip', () => {
  let dir: string
  let source: string

  const words: Word[] = 'the quick brown fox jumps over the lazy dog again and again'
    .split(' ')
    .map((text, i) => ({ t: i * 0.5, d: 0.5, text }))

  const spec = (over: Partial<RenderSpec> = {}): RenderSpec => ({
    input: 'source.mp4',
    output: 'out.mp4',
    start: 2,
    duration: 6,
    reframe: 'crop',
    focus: 0,
    sourceWidth: 1920,
    sourceHeight: 1080,
    hasAudio: true,
    captions: 'captions.ass',
    fontsDir: 'fonts',
    ...over,
  })

  const probeFile = async (name: string) =>
    parseProbe((await runOrThrow('ffprobe', probeArgs(join(dir, name)))).stdout)

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fableclip-render-'))

    // Fonts are handed to libass by directory, exactly as the pipeline does.
    await mkdir(join(dir, 'fonts'), { recursive: true })
    for (const font of Object.values(PRESETS)) {
      await copyFile(join(process.cwd(), 'assets', 'fonts', font.file), join(dir, 'fonts', font.file))
    }

    // A moving picture with a tone, so there is something real to cut.
    await runOrThrow('ffmpeg', [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=1920x1080:rate=30:duration=${SOURCE_SECONDS}`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=${SOURCE_SECONDS}`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      join(dir, 'source.mp4'),
    ])

    source = join(dir, 'source.mp4')
    await writeFile(
      join(dir, 'captions.ass'),
      buildAss(words, { width: 1080, height: 1920, preset: PRESETS.punch }),
      'utf8',
    )
  }, 180_000)

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('built a source to work from', async () => {
    expect(source).toBeTruthy()
    const info = await probeFile('source.mp4')
    expect(info).toMatchObject({ width: 1920, height: 1080, hasAudio: true })
  })

  it('renders a 1080x1920 clip ffmpeg accepts', async () => {
    await runOrThrow('ffmpeg', ffmpegArgs(spec()), { cwd: dir })

    const info = await probeFile('out.mp4')
    expect(info.width).toBe(1080)
    expect(info.height).toBe(1920)
  }, 180_000)

  it('cuts to the requested length', async () => {
    const info = await probeFile('out.mp4')
    expect(info.duration).toBeGreaterThan(5.5)
    expect(info.duration).toBeLessThan(6.6)
  })

  it('keeps the audio', async () => {
    expect((await probeFile('out.mp4')).hasAudio).toBe(true)
  })

  it('renders blur mode without ffmpeg rejecting the filter graph', async () => {
    await runOrThrow(
      'ffmpeg',
      ffmpegArgs(spec({ reframe: 'blur', output: 'blur.mp4' })),
      { cwd: dir },
    )

    const info = await probeFile('blur.mp4')
    expect(info).toMatchObject({ width: 1080, height: 1920 })
  }, 180_000)

  it('renders a silent source without an audio stream', async () => {
    await runOrThrow('ffmpeg', [
      '-hide_banner', '-nostdin', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=5',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      join(dir, 'silent.mp4'),
    ])

    await runOrThrow(
      'ffmpeg',
      ffmpegArgs(
        spec({
          input: 'silent.mp4',
          output: 'silent-out.mp4',
          hasAudio: false,
          sourceWidth: 1280,
          sourceHeight: 720,
          start: 0,
          duration: 3,
        }),
      ),
      { cwd: dir },
    )

    expect((await probeFile('silent-out.mp4')).hasAudio).toBe(false)
  }, 180_000)

  /**
   * The test that proves libass actually drew something.
   *
   * A wrong font name, an unreadable fontsdir or a malformed .ass all make
   * libass render nothing at all — and ffmpeg exits 0 regardless, so every
   * other check here would still pass while the clips shipped bare. Comparing
   * a frame rendered with captions against the same frame without them is the
   * only way to tell the difference from outside.
   */
  it('burns the captions into the picture', async () => {
    const frame = async (name: string, captions: string | null): Promise<Buffer> => {
      await runOrThrow(
        'ffmpeg',
        ffmpegArgs(spec({ output: name, captions, duration: 2 })),
        { cwd: dir },
      )
      await runOrThrow(
        'ffmpeg',
        ['-hide_banner', '-nostdin', '-y', '-ss', '1', '-i', name, '-frames:v', '1', `${name}.png`],
        { cwd: dir },
      )
      return readFile(join(dir, `${name}.png`))
    }

    const withCaptions = await frame('capped.mp4', 'captions.ass')
    const without = await frame('bare.mp4', null)

    expect(withCaptions.equals(without)).toBe(false)
  }, 240_000)

  it('accepts a crop that moves between shots', async () => {
    // The riskiest string this project builds: an ffmpeg expression full of
    // escaped commas. An unescaped one does not fail — it silently becomes a
    // different filter graph, so this has to be run rather than reasoned about.
    await runOrThrow(
      'ffmpeg',
      ffmpegArgs(
        spec({
          output: 'shots.mp4',
          captions: null,
          start: 0,
          duration: 6,
          crop: {
            w: 606,
            h: 1080,
            shots: [
              { from: 0, x: 0, y: 0 },
              { from: 2, x: 1314, y: 0 },
              { from: 4, x: 656, y: 0 },
            ],
            content: { x: 0, y: 0, w: 1920, h: 1080 },
          },
        }),
      ),
      { cwd: dir },
    )

    const info = await probeFile('shots.mp4')
    expect(info).toMatchObject({ width: 1080, height: 1920 })
  }, 240_000)

  it('actually moves the frame when the shot changes', async () => {
    const grab = async (name: string, at: number) => {
      await runOrThrow(
        'ffmpeg',
        ['-hide_banner', '-nostdin', '-y', '-ss', String(at), '-i', 'shots.mp4', '-frames:v', '1', name],
        { cwd: dir },
      )
      return readFile(join(dir, name))
    }

    // Hard left at 1s, hard right at 3s. Identical frames would mean the
    // expression parsed but never varied.
    expect((await grab('at1.png', 1)).equals(await grab('at3.png', 3))).toBe(false)
  }, 240_000)

  it('splices out the middle and comes back shorter', async () => {
    await runOrThrow(
      'ffmpeg',
      ffmpegArgs(
        spec({
          output: 'spliced.mp4',
          captions: null,
          start: 0,
          duration: 10,
          keep: [
            { from: 0, to: 2 },
            { from: 6, to: 9 },
          ],
        }),
      ),
      { cwd: dir },
    )

    const info = await probeFile('spliced.mp4')
    // 2s + 3s kept out of a 10s window.
    expect(info.duration).toBeGreaterThan(4.4)
    expect(info.duration).toBeLessThan(5.8)
    expect(info.hasAudio).toBe(true)
  }, 240_000)

  it('keeps audio and video the same length through a splice', async () => {
    const durations = (
      await runOrThrow('ffprobe', [
        '-v', 'error',
        '-show_entries', 'stream=codec_type,duration',
        '-of', 'csv=p=0',
        join(dir, 'spliced.mp4'),
      ])
    ).stdout
      .trim()
      .split('\n')
      .map((line) => Number(line.split(',')[1]))

    expect(Math.abs(durations[0] - durations[1])).toBeLessThan(0.4)
  }, 120_000)

  it('crops the region cropRect asked for, not some other one', async () => {
    // Rendered at hard-left and hard-right, the two frames cannot match unless
    // the focus offset was ignored.
    const left = 'left.mp4'
    const right = 'right.mp4'

    for (const [name, focus] of [
      [left, -1],
      [right, 1],
    ] as const) {
      await runOrThrow(
        'ffmpeg',
        ffmpegArgs(spec({ output: name, focus, captions: null, duration: 1 })),
        { cwd: dir },
      )
      await runOrThrow(
        'ffmpeg',
        ['-hide_banner', '-nostdin', '-y', '-i', name, '-frames:v', '1', `${name}.png`],
        { cwd: dir },
      )
    }

    const a = await readFile(join(dir, `${left}.png`))
    const b = await readFile(join(dir, `${right}.png`))

    expect(cropRect(1920, 1080, -1).x).not.toBe(cropRect(1920, 1080, 1).x)
    expect(a.equals(b)).toBe(false)
  }, 240_000)
})
