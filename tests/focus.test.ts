import { describe, expect, it } from 'vitest'
import {
  bestFocus,
  columnActivity,
  contentRect,
  planCrop,
  shotBoundaries,
  sampleArgs,
  MAX_SAMPLES,
  SAMPLE_FPS,
  SAMPLE_HEIGHT,
  sampleFps,
  SAMPLE_WIDTH,
  toFrames,
} from '@/lib/focus'

/** A frame with a bright, noisy patch centred on `at` (0–1 across the width). */
function frameWithPatch(at: number, seed = 0, width = SAMPLE_WIDTH, height = SAMPLE_HEIGHT) {
  const plane = new Uint8Array(width * height).fill(30)
  const centre = Math.round(at * (width - 1))

  for (let y = 0; y < height; y++) {
    for (let dx = -8; dx <= 8; dx++) {
      const x = centre + dx
      if (x < 0 || x >= width) continue
      // Varying by seed makes the patch *move* between frames; varying by
      // position makes it carry detail.
      plane[y * width + x] = 120 + ((x * 7 + y * 3 + seed * 40) % 120)
    }
  }
  return plane
}

const flat = (value = 40, width = SAMPLE_WIDTH, height = SAMPLE_HEIGHT) =>
  new Uint8Array(width * height).fill(value)

describe('toFrames', () => {
  it('splits a rawvideo blob into planes', () => {
    const raw = new Uint8Array(SAMPLE_WIDTH * SAMPLE_HEIGHT * 3)
    expect(toFrames(raw)).toHaveLength(3)
  })

  it('ignores a trailing partial frame rather than reading past the end', () => {
    const raw = new Uint8Array(SAMPLE_WIDTH * SAMPLE_HEIGHT * 2 + 17)
    expect(toFrames(raw)).toHaveLength(2)
  })

  it('returns nothing for an empty blob', () => {
    expect(toFrames(new Uint8Array(0))).toEqual([])
  })

  it('gives each frame the full plane size', () => {
    const raw = new Uint8Array(SAMPLE_WIDTH * SAMPLE_HEIGHT * 2)
    expect(toFrames(raw)[0]).toHaveLength(SAMPLE_WIDTH * SAMPLE_HEIGHT)
  })
})

describe('columnActivity', () => {
  it('returns one number per column', () => {
    const activity = columnActivity([flat(), flat()])
    expect(activity).toHaveLength(SAMPLE_WIDTH)
  })

  it('is flat for a completely uniform picture', () => {
    const activity = columnActivity([flat(), flat(), flat()])
    expect(activity.every((v) => v === 0)).toBe(true)
  })

  it('peaks where the picture is moving', () => {
    const frames = [frameWithPatch(0.75, 0), frameWithPatch(0.75, 1), frameWithPatch(0.75, 2)]
    const activity = columnActivity(frames)

    const peak = activity.indexOf(Math.max(...activity))
    expect(peak / SAMPLE_WIDTH).toBeGreaterThan(0.6)
    expect(peak / SAMPLE_WIDTH).toBeLessThan(0.9)
  })

  it('finds a left-hand subject as readily as a right-hand one', () => {
    const frames = [frameWithPatch(0.2, 0), frameWithPatch(0.2, 1), frameWithPatch(0.2, 2)]
    const activity = columnActivity(frames)

    const peak = activity.indexOf(Math.max(...activity))
    expect(peak / SAMPLE_WIDTH).toBeLessThan(0.4)
  })

  it('still reports detail when nothing moves at all', () => {
    // A single frame repeated: no motion, but the patch is still the only
    // thing in the picture worth pointing a camera at.
    const still = frameWithPatch(0.3, 0)
    const activity = columnActivity([still, still, still])
    expect(Math.max(...activity)).toBeGreaterThan(0)
  })

  it('survives a single frame', () => {
    expect(() => columnActivity([flat()])).not.toThrow()
  })

  it('survives no frames', () => {
    expect(columnActivity([])).toHaveLength(SAMPLE_WIDTH)
  })
})

describe('bestFocus', () => {
  const uniform = new Array(SAMPLE_WIDTH).fill(1)

  it('stays centred when every column is equally interesting', () => {
    expect(bestFocus(uniform, 1920, 1080)).toBe(0)
  })

  it('stays centred when there is nothing to go on', () => {
    expect(bestFocus(new Array(SAMPLE_WIDTH).fill(0), 1920, 1080)).toBe(0)
  })

  it('moves right for a right-hand subject', () => {
    const activity = uniform.map((_, i) => (i > SAMPLE_WIDTH * 0.7 ? 10 : 0.2))
    expect(bestFocus(activity, 1920, 1080)).toBeGreaterThan(0.3)
  })

  it('moves left for a left-hand subject', () => {
    const activity = uniform.map((_, i) => (i < SAMPLE_WIDTH * 0.3 ? 10 : 0.2))
    expect(bestFocus(activity, 1920, 1080)).toBeLessThan(-0.3)
  })

  it('never leaves the range the crop accepts', () => {
    for (const at of [0, 0.1, 0.5, 0.9, 1]) {
      const activity = uniform.map((_, i) =>
        Math.abs(i / SAMPLE_WIDTH - at) < 0.05 ? 50 : 0,
      )
      const focus = bestFocus(activity, 1920, 1080)
      expect(focus).toBeGreaterThanOrEqual(-1)
      expect(focus).toBeLessThanOrEqual(1)
    }
  })

  it('does not chase a marginally busier edge', () => {
    // 4% more activity on the right is noise, not a subject.
    const activity = uniform.map((_, i) => (i > SAMPLE_WIDTH / 2 ? 1.04 : 1))
    expect(Math.abs(bestFocus(activity, 1920, 1080))).toBeLessThan(0.2)
  })

  it('picks a speaker over the gap between two of them', () => {
    // A side-by-side interview: two busy halves with a dip in the middle. A
    // flat pull toward the centre parked the crop on the seam — a frame of
    // two half-faces and the bars between them.
    const activity = uniform.map((_, i) => {
      const at = i / SAMPLE_WIDTH
      if (at > 0.08 && at < 0.42) return 8
      if (at > 0.58 && at < 0.92) return 9
      return 0.4
    })

    const focus = bestFocus(activity, 1920, 1080)
    expect(Math.abs(focus)).toBeGreaterThan(0.25)
  })

  it('stays centred when the crop already covers the whole frame', () => {
    const activity = uniform.map((_, i) => (i > SAMPLE_WIDTH * 0.8 ? 10 : 0))
    expect(bestFocus(activity, 1080, 1920)).toBe(0)
  })

  it('handles an empty activity list', () => {
    expect(bestFocus([], 1920, 1080)).toBe(0)
  })

  it('picks the speaking half of a side-by-side two-shot', () => {
    // The shot that prompted all of this: two Zoom windows, the right-hand
    // one talking. A centre crop lands on the seam between them.
    const activity = uniform.map((_, i) => {
      const at = i / SAMPLE_WIDTH
      if (at > 0.55 && at < 0.9) return 9 // the person speaking
      if (at > 0.1 && at < 0.45) return 3 // the person listening
      return 0.1 // black bars and background
    })

    const focus = bestFocus(activity, 1920, 1080)
    expect(focus).toBeGreaterThan(0.2)
  })

  it('is deterministic', () => {
    const activity = uniform.map((_, i) => Math.sin(i) + 1)
    expect(bestFocus(activity, 1920, 1080)).toBe(bestFocus(activity, 1920, 1080))
  })
})

describe('sampleArgs', () => {
  const args = sampleArgs('source.mp4', 'focus.raw', 120, 45)

  it('seeks before the input, so a late clip is not decoded from zero', () => {
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'))
  })

  it('samples at postage-stamp size', () => {
    expect(args.join(' ')).toContain(`scale=${SAMPLE_WIDTH}:${SAMPLE_HEIGHT}`)
  })

  it('asks for greyscale, since colour tells it nothing', () => {
    expect(args).toContain('gray')
  })

  it('looks at the whole clip, not a window off the front', () => {
    // Sampling only the opening let the first shot decide the framing for the
    // whole clip — a video that cut from a letterboxed tile to a full frame
    // kept the tile's framing throughout.
    const long = sampleArgs('source.mp4', 'focus.raw', 0, 600)
    expect(Number(long[long.indexOf('-t') + 1])).toBe(600)
  })

  it('thins the sample rate instead of shortening the window', () => {
    const rate = (duration: number): number => {
      const built = sampleArgs('source.mp4', 'focus.raw', 0, duration)
      return Number(built.join(' ').match(/fps=([\d.]+)/)?.[1])
    }
    expect(rate(600)).toBeLessThan(rate(30))
  })

  it('never samples faster than the full rate', () => {
    for (const duration of [1, 5, 12, 45, 180, 600]) {
      expect(sampleFps(duration)).toBeLessThanOrEqual(SAMPLE_FPS)
    }
  })

  it('keeps a clip of any plausible length to a workable number of frames', () => {
    // Clips are capped at 180s by the job options, so this is the real range.
    for (const duration of [5, 30, 60, 180]) {
      expect(sampleFps(duration) * duration).toBeLessThanOrEqual(MAX_SAMPLES + 12)
    }
  })

  it('keeps enough temporal resolution to see a shot change', () => {
    // A floor, so a long clip is not reduced to a handful of frames that
    // cannot tell a cut from a camera move.
    expect(sampleFps(600)).toBeGreaterThanOrEqual(0.2)
  })

  it('writes raw planes, not an encoded file', () => {
    expect(args).toContain('rawvideo')
  })
})


/** A frame that is picture only between `top` and `bottom` (0–1 of height). */
function letterboxed(top: number, bottom: number, seed = 0, width = SAMPLE_WIDTH, height = SAMPLE_HEIGHT) {
  const plane = new Uint8Array(width * height).fill(0)
  const from = Math.round(top * height)
  const to = Math.round(bottom * height)

  for (let y = from; y < to; y++) {
    for (let x = 0; x < width; x++) {
      plane[y * width + x] = 90 + ((x * 5 + y * 3 + seed * 30) % 120)
    }
  }
  return plane
}

describe('contentRect', () => {
  const frames = [letterboxed(0.25, 0.75, 0), letterboxed(0.25, 0.75, 1), letterboxed(0.25, 0.75, 2)]

  it('finds the picture inside a letterbox', () => {
    const rect = contentRect(frames, 1920, 1080)
    expect(rect.y).toBeGreaterThan(200)
    expect(rect.y + rect.h).toBeLessThan(880)
  })

  it('keeps the full width when only the top and bottom are barred', () => {
    const rect = contentRect(frames, 1920, 1080)
    expect(rect.x).toBe(0)
    expect(rect.w).toBe(1920)
  })

  it('leaves a frame that is all picture alone', () => {
    const full = [flat(120), flat(130), flat(120)]
    expect(contentRect(full, 1920, 1080)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 })
  })

  it('refuses to trim more than the cap off a side', () => {
    // Almost the whole frame is dark — a night scene, not a letterbox.
    const dark = [letterboxed(0.47, 0.53, 0), letterboxed(0.47, 0.53, 1)]
    const rect = contentRect(dark, 1920, 1080)
    expect(rect.h).toBeGreaterThan(1080 * 0.28)
  })

  it('does not trim a dark scene that has highlights in it', () => {
    // Dim everywhere, but every row reaches past the dark threshold at least
    // once across the clip.
    const dim = new Uint8Array(SAMPLE_WIDTH * SAMPLE_HEIGHT).fill(40)
    const rect = contentRect([dim, dim], 1920, 1080)
    expect(rect).toEqual({ x: 0, y: 0, w: 1920, h: 1080 })
  })

  it('returns even numbers, which is what libx264 accepts', () => {
    const rect = contentRect(frames, 1920, 1080)
    for (const v of [rect.x, rect.y, rect.w, rect.h]) expect(v % 2).toBe(0)
  })

  it('never reaches outside the source', () => {
    const rect = contentRect(frames, 1920, 1080)
    expect(rect.x + rect.w).toBeLessThanOrEqual(1920)
    expect(rect.y + rect.h).toBeLessThanOrEqual(1080)
  })

  it('handles no frames', () => {
    expect(contentRect([], 1280, 720)).toEqual({ x: 0, y: 0, w: 1280, h: 720 })
  })

  it('handles a frame that is entirely black', () => {
    const rect = contentRect([flat(0), flat(0)], 1920, 1080)
    expect(rect.w).toBeGreaterThan(0)
    expect(rect.h).toBeGreaterThan(0)
  })
})

describe('shotBoundaries', () => {
  it('starts at the first frame', () => {
    expect(shotBoundaries([flat(), flat()])[0]).toBe(0)
  })

  it('finds one shot in a steady picture', () => {
    const still = frameWithPatch(0.5, 0)
    expect(shotBoundaries([still, still, still, still, still])).toEqual([0])
  })

  it('finds the cut when the picture changes wholesale', () => {
    const a = frameWithPatch(0.2, 0)
    const b = flat(200)
    const shots = shotBoundaries([a, a, a, a, b, b, b, b])
    expect(shots.length).toBeGreaterThan(1)
    expect(shots[1]).toBe(4)
  })

  it('ignores a cut too soon after the last one', () => {
    const a = frameWithPatch(0.2, 0)
    const b = flat(200)
    // Alternating every frame is flicker, not editing.
    expect(shotBoundaries([a, b, a, b, a, b], 2)).toEqual([0])
  })

  it('measures the minimum shot in seconds, not frames', () => {
    // The sample rate falls with clip length, so a fixed frame count meant
    // five seconds on a long clip — which swallowed every short opening shot.
    const a = frameWithPatch(0.2, 0)
    const b = flat(200)
    const frames = [a, a, b, b, b, b]

    // At half a frame per second, two frames is four seconds — a real shot.
    expect(shotBoundaries(frames, 0.5).length).toBeGreaterThan(1)
    // At eight frames per second, the same two frames is a quarter second.
    expect(shotBoundaries(frames, 8)).toEqual([0])
  })

  it('handles a single frame', () => {
    expect(shotBoundaries([flat()])).toEqual([0])
  })

  it('handles no frames', () => {
    expect(shotBoundaries([])).toEqual([0])
  })
})

describe('planCrop', () => {
  it('gives one shot for a steady picture', () => {
    const still = frameWithPatch(0.5, 0)
    expect(planCrop([still, still, still, still], 1920, 1080).shots).toHaveLength(1)
  })

  it('always starts at zero seconds', () => {
    const still = frameWithPatch(0.5, 0)
    expect(planCrop([still, still, still], 1920, 1080).shots[0].from).toBe(0)
  })

  it('re-frames when the subject moves to the other side', () => {
    const left = Array.from({ length: 4 }, (_, i) => frameWithPatch(0.15, i))
    const right = Array.from({ length: 4 }, (_, i) => frameWithPatch(0.85, i))

    const plan = planCrop([...left, ...right], 1920, 1080)
    expect(plan.shots.length).toBeGreaterThan(1)
    expect(plan.shots[0].x).toBeLessThan(plan.shots[plan.shots.length - 1].x)
  })

  it('keeps the crop the same size throughout, whatever the shots do', () => {
    const a = Array.from({ length: 4 }, (_, i) => letterboxed(0.2, 0.8, i))
    const b = Array.from({ length: 4 }, (_, i) => flat(120 + i))
    const plan = planCrop([...a, ...b], 1920, 1080)

    expect(plan.w).toBeGreaterThan(0)
    expect(plan.h).toBeGreaterThan(0)
    expect(plan.w % 2).toBe(0)
    expect(plan.h % 2).toBe(0)
  })

  it('sizes to the shot the clip mostly is, not to a brief outlier', () => {
    // A two-second letterboxed insert followed by a long full-frame shot.
    // Sizing to the insert cropped the whole clip to a face with the top of
    // the head cut off.
    const boxed = Array.from({ length: 2 }, (_, i) => letterboxed(0.35, 0.65, i))
    const full = Array.from({ length: 10 }, (_, i) => frameWithPatch(0.5, i))

    const plan = planCrop([...boxed, ...full], 1920, 1080)
    expect(plan.h).toBeGreaterThan(1080 * 0.7)
  })

  it('still sizes to a letterbox that dominates the clip', () => {
    const boxed = Array.from({ length: 10 }, (_, i) => letterboxed(0.25, 0.75, i))
    const full = Array.from({ length: 2 }, (_, i) => frameWithPatch(0.5, i))

    const plan = planCrop([...boxed, ...full], 1920, 1080)
    expect(plan.h).toBeLessThan(1080 * 0.7)
  })

  it('never crops outside the source', () => {
    const frames = Array.from({ length: 6 }, (_, i) => frameWithPatch(i < 3 ? 0.1 : 0.9, i))
    const plan = planCrop(frames, 1920, 1080)

    for (const shot of plan.shots) {
      expect(shot.x).toBeGreaterThanOrEqual(0)
      expect(shot.y).toBeGreaterThanOrEqual(0)
      expect(shot.x + plan.w).toBeLessThanOrEqual(1920)
      expect(shot.y + plan.h).toBeLessThanOrEqual(1080)
    }
  })

  it('reports shot times in seconds, in order', () => {
    const left = Array.from({ length: 4 }, (_, i) => frameWithPatch(0.15, i))
    const right = Array.from({ length: 4 }, (_, i) => frameWithPatch(0.85, i))
    const plan = planCrop([...left, ...right], 1920, 1080, 2)

    for (let i = 1; i < plan.shots.length; i++) {
      expect(plan.shots[i].from).toBeGreaterThan(plan.shots[i - 1].from)
    }
  })

  it('does not jump the frame for a few pixels', () => {
    const a = Array.from({ length: 4 }, (_, i) => frameWithPatch(0.5, i))
    const b = Array.from({ length: 4 }, (_, i) => frameWithPatch(0.51, i))
    expect(planCrop([...a, ...b], 1920, 1080).shots).toHaveLength(1)
  })

  it('reports the picture area for the modes that keep the whole frame', () => {
    const boxed = Array.from({ length: 4 }, (_, i) => letterboxed(0.25, 0.75, i))
    expect(planCrop(boxed, 1920, 1080).content.h).toBeLessThan(1080)
  })

  it('falls back to a centre crop given nothing', () => {
    const plan = planCrop([], 1920, 1080)
    expect(plan.shots).toHaveLength(1)
    expect(plan.content).toEqual({ x: 0, y: 0, w: 1920, h: 1080 })
  })
})

describe('sampleFps', () => {
  it('covers a long clip rather than only its opening', () => {
    // Sampling a fixed window off the front let the first shot decide the
    // framing for the whole clip.
    expect(sampleFps(60) * 60).toBeLessThanOrEqual(MAX_SAMPLES + 0.01)
  })

  it('does not oversample a short clip', () => {
    expect(sampleFps(5)).toBeLessThanOrEqual(SAMPLE_FPS)
  })

  it('never returns zero', () => {
    expect(sampleFps(0)).toBeGreaterThan(0)
    expect(sampleFps(10_000)).toBeGreaterThan(0)
  })
})
