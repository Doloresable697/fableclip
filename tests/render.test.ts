import { describe, expect, it } from 'vitest'
import {
  audioArgs,
  audioFilter,
  cropRect,
  cropCoordExpr,
  focusCrop,
  ffmpegArgs,
  filterChain,
  OUT_HEIGHT,
  OUT_WIDTH,
  parseProbe,
  parseRenderProgress,
  probeArgs,
  thumbnailArgs,
  type RenderSpec,
} from '@/lib/render'

const spec = (over: Partial<RenderSpec> = {}): RenderSpec => ({
  input: 'source.mp4',
  output: 'clip-0.mp4',
  start: 12.5,
  duration: 30,
  reframe: 'crop',
  focus: 0,
  sourceWidth: 1920,
  sourceHeight: 1080,
  hasAudio: true,
  captions: 'clip-0.ass',
  fontsDir: '../fonts',
  ...over,
})

describe('cropRect', () => {
  it('takes a 9:16 slice out of a 16:9 frame', () => {
    const rect = cropRect(1920, 1080, 0)
    expect(rect.h).toBe(1080)
    expect(rect.w / rect.h).toBeCloseTo(OUT_WIDTH / OUT_HEIGHT, 2)
  })

  it('centres the slice at focus 0', () => {
    // Within a pixel: forcing every value even cannot always land exactly on
    // the midpoint, and a one-pixel bias is not a visible one.
    const rect = cropRect(1920, 1080, 0)
    expect(Math.abs(rect.x + rect.w / 2 - 960)).toBeLessThanOrEqual(1)
  })

  it('pins the slice left at focus −1', () => {
    expect(cropRect(1920, 1080, -1).x).toBe(0)
  })

  it('pins the slice right at focus 1', () => {
    const rect = cropRect(1920, 1080, 1)
    expect(rect.x + rect.w).toBeCloseTo(1920, 0)
  })

  it('never crops outside the frame, whatever focus it is given', () => {
    for (const focus of [-5, -1, 0, 1, 5]) {
      const rect = cropRect(1920, 1080, focus)
      expect(rect.x).toBeGreaterThanOrEqual(0)
      expect(rect.x + rect.w).toBeLessThanOrEqual(1920)
    }
  })

  it('returns only even dimensions, which is what libx264 accepts', () => {
    for (const [w, h] of [
      [1920, 1080],
      [1919, 1079],
      [1280, 720],
      [854, 480],
    ]) {
      const rect = cropRect(w, h, 0.3)
      for (const value of [rect.w, rect.h, rect.x, rect.y]) {
        expect(value % 2).toBe(0)
      }
    }
  })

  it('crops height instead when the source is already tall', () => {
    const rect = cropRect(1080, 2400, 0)
    expect(rect.w).toBe(1080)
    expect(rect.h).toBeLessThan(2400)
  })

  it('anchors a tall crop above centre, where faces are', () => {
    const rect = cropRect(1080, 2400, 0)
    expect(rect.y).toBeLessThan((2400 - rect.h) / 2)
  })

  it('handles a source that is already exactly 9:16', () => {
    const rect = cropRect(1080, 1920, 0)
    expect(rect).toEqual({ w: 1080, h: 1920, x: 0, y: 0 })
  })
})

describe('filterChain', () => {
  it('crops then scales to the output size', () => {
    const chain = filterChain(spec())
    expect(chain).toMatch(/^\[0:v\]crop=w=\d+:h=\d+:x=\d+:y=\d+,scale=1080:1920/)
  })

  it('labels its output, because the graph is mapped by name', () => {
    for (const reframe of ['crop', 'blur', 'original'] as const) {
      expect(filterChain(spec({ reframe }))).toMatch(/\[v\]$/)
    }
  })

  it('splits the frame explicitly rather than relying on ffmpeg to infer it', () => {
    expect(filterChain(spec({ reframe: 'blur' }))).toContain('split=2')
  })

  it('reads each input pad exactly once, which is what makes the graph valid', () => {
    for (const reframe of ['crop', 'blur', 'original'] as const) {
      const chain = filterChain(spec({ reframe }))
      expect(chain.match(/\[0:v\]/g) ?? []).toHaveLength(1)
    }
  })

  it('forces even dimensions in original mode, which libx264 requires', () => {
    expect(filterChain(spec({ reframe: 'original' }))).toContain('trunc(iw/2)*2')
  })

  it('burns captions after the frame is its final size', () => {
    const chain = filterChain(spec())
    expect(chain.indexOf('scale=')).toBeLessThan(chain.indexOf('subtitles='))
  })

  it('omits the subtitles filter when there are no captions', () => {
    expect(filterChain(spec({ captions: null }))).not.toContain('subtitles')
  })

  it('points libass at the staged fonts', () => {
    expect(filterChain(spec())).toContain('fontsdir=../fonts')
  })

  it('uses only paths ffmpeg cannot misparse', () => {
    const chain = filterChain(spec())
    const subtitles = chain.match(/subtitles=([^,]+)/)?.[1] ?? ''
    expect(subtitles).not.toMatch(/[ '"]/)
  })

  it('builds a blurred backdrop and an overlay for blur mode', () => {
    const chain = filterChain(spec({ reframe: 'blur' }))
    expect(chain).toContain('boxblur')
    expect(chain).toContain('[bg][fg]overlay')
  })

  it('still burns captions in blur mode', () => {
    expect(filterChain(spec({ reframe: 'blur' }))).toContain('subtitles=')
  })

  it('leaves the framing alone in original mode', () => {
    const chain = filterChain(spec({ reframe: 'original' }))
    expect(chain).not.toContain('crop=')
    expect(chain).not.toContain('overlay')
  })

  it('always ends up in a pixel format every player accepts', () => {
    for (const reframe of ['crop', 'blur', 'original'] as const) {
      expect(filterChain(spec({ reframe }))).toContain('format=yuv420p')
    }
  })
})

describe('focusCrop', () => {
  it('places the window inside the active picture, not the whole frame', () => {
    const content = { x: 0, y: 240, w: 1920, h: 600 }
    const rect = focusCrop(content, 0)
    expect(rect.y).toBeGreaterThanOrEqual(240)
    expect(rect.y + rect.h).toBeLessThanOrEqual(840)
  })

  it('offsets horizontally by the content origin', () => {
    const rect = focusCrop({ x: 400, y: 0, w: 600, h: 600 }, -1)
    expect(rect.x).toBe(400)
  })

  it('is the plain crop when the content is the whole frame', () => {
    const whole = { x: 0, y: 0, w: 1920, h: 1080 }
    expect(focusCrop(whole, 0.4)).toEqual(cropRect(1920, 1080, 0.4))
  })
})

describe('cropCoordExpr', () => {
  it('is a plain number when the framing never moves', () => {
    expect(cropCoordExpr([{ from: 0, x: 640, y: 0 }], 'x')).toBe('640')
  })

  it('builds a chain of ifs when it does', () => {
    const expr = cropCoordExpr(
      [
        { from: 0, x: 0, y: 0 },
        { from: 4.5, x: 900, y: 0 },
      ],
      'x',
    )
    expect(expr).toContain('if(lt(t')
    expect(expr).toContain('4.500')
  })

  it('escapes every comma, or ffmpeg reads a different graph entirely', () => {
    const expr = cropCoordExpr(
      [
        { from: 0, x: 0, y: 0 },
        { from: 2, x: 400, y: 0 },
        { from: 4, x: 900, y: 0 },
      ],
      'x',
    )
    expect(expr).not.toMatch(/[^\\],/)
  })

  it('does not also quote — escaping and quoting together is broken', () => {
    expect(cropCoordExpr([{ from: 0, x: 1, y: 2 }, { from: 1, x: 3, y: 4 }], 'y')).not.toContain("'")
  })

  it('nests so the earliest shot is tested first', () => {
    const expr = cropCoordExpr(
      [
        { from: 0, x: 10, y: 0 },
        { from: 3, x: 90, y: 0 },
      ],
      'x',
    )
    expect(expr).toBe('if(lt(t\\,3.000)\\,10\\,90)')
  })

  it('reads the axis it was asked for', () => {
    const shots = [
      { from: 0, x: 10, y: 77 },
      { from: 2, x: 30, y: 88 },
    ]
    expect(cropCoordExpr(shots, 'y')).toContain('77')
    expect(cropCoordExpr(shots, 'y')).toContain('88')
    expect(cropCoordExpr(shots, 'y')).not.toContain('30')
  })

  it('falls back rather than emitting an empty expression', () => {
    expect(cropCoordExpr([], 'x')).toBe('0')
  })
})

describe('filterChain — letterbox and splices', () => {
  const spliced = {
    keep: [
      { from: 0, to: 4 },
      { from: 7, to: 12 },
    ],
  }

  it('drops the removed ranges and restamps', () => {
    const chain = filterChain(spec(spliced))
    expect(chain).toContain('select=')
    expect(chain).toContain('setpts=N/FRAME_RATE/TB')
  })

  it('does not reach for select when nothing was removed', () => {
    expect(filterChain(spec({ keep: [{ from: 0, to: 10 }] }))).not.toContain('select=')
  })

  it('frames before it cuts, so the crop clock is still the source clock', () => {
    const chain = filterChain(
      spec({
        ...spliced,
        crop: {
          w: 606,
          h: 1080,
          shots: [
            { from: 0, x: 0, y: 0 },
            { from: 5, x: 900, y: 0 },
          ],
          content: { x: 0, y: 0, w: 1920, h: 1080 },
        },
      }),
    )
    expect(chain.indexOf('crop=')).toBeLessThan(chain.indexOf('select='))
  })

  it('keeps the crop size fixed while the origin moves', () => {
    const chain = filterChain(
      spec({
        crop: {
          w: 606,
          h: 540,
          shots: [
            { from: 0, x: 0, y: 270 },
            { from: 5, x: 900, y: 0 },
          ],
          content: { x: 0, y: 0, w: 1920, h: 1080 },
        },
      }),
    )
    expect(chain).toContain('crop=w=606:h=540')
    expect(chain.match(/w=606/g) ?? []).toHaveLength(1)
  })

  it('scales after cutting, so discarded frames are never resized', () => {
    const chain = filterChain(spec(spliced))
    expect(chain.indexOf('select=')).toBeLessThan(chain.indexOf('scale='))
  })

  it('crops the letterbox off in blur mode too', () => {
    const chain = filterChain(
      spec({
        reframe: 'blur',
        crop: {
          w: 450,
          h: 800,
          shots: [{ from: 0, x: 700, y: 140 }],
          content: { x: 0, y: 140, w: 1920, h: 800 },
        },
      }),
    )
    expect(chain).toContain('crop=1920:800:0:140')
  })

  it('leaves blur mode alone when the frame is all picture', () => {
    const chain = filterChain(spec({ reframe: 'blur' }))
    expect(chain.startsWith('[0:v]split=2')).toBe(true)
  })

  it('still ends on one labelled output whatever it did', () => {
    for (const reframe of ['crop', 'blur', 'original'] as const) {
      const chain = filterChain(spec({ ...spliced, reframe }))
      expect(chain).toMatch(/\[v\]$/)
      expect(chain.match(/\[0:v\]/g) ?? []).toHaveLength(1)
    }
  })
})

describe('audioFilter', () => {
  it('drops the same ranges the video did', () => {
    const flags = audioFilter(spec({ keep: [{ from: 0, to: 2 }, { from: 5, to: 9 }] }))
    expect(flags.join(' ')).toContain('aselect=')
    expect(flags.join(' ')).toContain('asetpts=N/SR/TB')
  })

  it('normalises loudness either way', () => {
    expect(audioFilter(spec()).join(' ')).toContain('loudnorm=I=-16')
  })

  it('does not reach for aselect on a continuous clip', () => {
    expect(audioFilter(spec()).join(' ')).not.toContain('aselect')
  })
})

describe('ffmpegArgs', () => {
  it('seeks before the input, not after', () => {
    const args = ffmpegArgs(spec())
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'))
  })

  it('passes the trim as a duration rather than an end time', () => {
    const args = ffmpegArgs(spec())
    expect(args[args.indexOf('-t') + 1]).toBe('30.000')
  })

  it('uses filter_complex, the only form that accepts the blur graph', () => {
    const args = ffmpegArgs(spec())
    expect(args).toContain('-filter_complex')
    expect(args).not.toContain('-vf')
  })

  it('maps the labelled video output', () => {
    const args = ffmpegArgs(spec())
    expect(args[args.indexOf('-map') + 1]).toBe('[v]')
  })

  it('maps the audio too — naming a video output disables auto-selection', () => {
    expect(ffmpegArgs(spec()).join(' ')).toContain('-map 0:a:0')
  })

  it('maps no audio for a silent source', () => {
    expect(ffmpegArgs(spec({ hasAudio: false })).join(' ')).not.toContain('0:a')
  })

  it('encodes something every phone plays', () => {
    const args = ffmpegArgs(spec())
    expect(args).toContain('libx264')
    expect(args).toContain('aac')
  })

  it('normalises loudness to the level platforms target', () => {
    const args = ffmpegArgs(spec())
    expect(args.join(' ')).toContain('loudnorm=I=-16')
  })

  it('drops the audio flags entirely for a silent source', () => {
    const args = ffmpegArgs(spec({ hasAudio: false }))
    expect(args).toContain('-an')
    expect(args).not.toContain('aac')
  })

  it('moves the index to the front so the file streams', () => {
    expect(ffmpegArgs(spec()).join(' ')).toContain('+faststart')
  })

  it('asks for machine-readable progress', () => {
    expect(ffmpegArgs(spec())).toContain('-progress')
  })

  it('writes the output last, where ffmpeg expects it', () => {
    const args = ffmpegArgs(spec())
    expect(args[args.length - 1]).toBe('clip-0.mp4')
  })

  it('never blocks on stdin, which would hang an unattended render', () => {
    expect(ffmpegArgs(spec())).toContain('-nostdin')
  })
})

describe('parseProbe', () => {
  const json = JSON.stringify({
    streams: [
      { codec_type: 'video', width: 1920, height: 1080 },
      { codec_type: 'audio' },
    ],
    format: { duration: '2295.849796' },
  })

  it('reads the video dimensions', () => {
    expect(parseProbe(json)).toMatchObject({ width: 1920, height: 1080 })
  })

  it('reads the duration as a number', () => {
    expect(parseProbe(json).duration).toBeCloseTo(2295.85, 1)
  })

  it('notices there is audio', () => {
    expect(parseProbe(json).hasAudio).toBe(true)
  })

  it('notices there is not', () => {
    const silent = JSON.stringify({
      streams: [{ codec_type: 'video', width: 640, height: 480 }],
      format: { duration: '5' },
    })
    expect(parseProbe(silent).hasAudio).toBe(false)
  })

  it('throws on output that is not JSON at all', () => {
    expect(() => parseProbe('ffprobe: command not found')).toThrow()
  })

  it('returns zeroes rather than NaN for a file with no video stream', () => {
    const audioOnly = JSON.stringify({ streams: [{ codec_type: 'audio' }], format: {} })
    expect(parseProbe(audioOnly)).toEqual({
      width: 0,
      height: 0,
      duration: 0,
      hasAudio: true,
    })
  })
})

describe('parseRenderProgress', () => {
  it('reads out_time_ms, which ffmpeg reports in microseconds', () => {
    expect(parseRenderProgress('out_time_ms=5000000')).toBe(5)
  })

  it('reads the timestamp form as a fallback', () => {
    expect(parseRenderProgress('out_time=00:01:30.500000')).toBe(90)
  })

  it('ignores every other line', () => {
    expect(parseRenderProgress('frame=120')).toBeNull()
    expect(parseRenderProgress('speed=1.2x')).toBeNull()
  })
})

describe('audioArgs', () => {
  it('extracts 16 kHz mono, which is what Whisper wants', () => {
    const args = audioArgs('source.mp4', 'audio.wav')
    expect(args).toContain('16000')
    expect(args[args.indexOf('-ac') + 1]).toBe('1')
  })

  it('drops the video stream', () => {
    expect(audioArgs('a.mp4', 'a.wav')).toContain('-vn')
  })
})

describe('thumbnailArgs', () => {
  it('takes exactly one frame', () => {
    const args = thumbnailArgs('clip.mp4', 'clip.jpg', 1)
    expect(args[args.indexOf('-frames:v') + 1]).toBe('1')
  })

  it('seeks to the requested moment', () => {
    expect(thumbnailArgs('clip.mp4', 'clip.jpg', 2.5)).toContain('2.500')
  })
})

describe('probeArgs', () => {
  it('asks for JSON, which is what parseProbe reads', () => {
    expect(probeArgs('x.mp4')).toContain('json')
  })

  it('puts the path last', () => {
    const args = probeArgs('x.mp4')
    expect(args[args.length - 1]).toBe('x.mp4')
  })
})
