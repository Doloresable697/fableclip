import { describe, expect, it } from 'vitest'
import { DEFAULT_CUT, isContinuous, planCut, retime, selectExpr } from '@/lib/cut'
import type { Word } from '@/lib/types'

/** Words laid end to end from `start`, each `each` long, `gap` apart. */
function say(text: string, start = 0, each = 0.4, gap = 0): Word[] {
  let t = start
  return text.split(' ').map((word) => {
    const w = { t, d: each, text: word }
    t += each + gap
    return w
  })
}

const total = (keep: Array<{ from: number; to: number }>): number =>
  keep.reduce((n, k) => n + (k.to - k.from), 0)

describe('planCut — snapping to speech', () => {
  const words = say('one two three four', 10, 0.5)

  it('starts a beat before the first word, not at the range edge', () => {
    const plan = planCut(words, 5, 20)
    expect(plan.keep[0].from).toBeCloseTo(10 - DEFAULT_CUT.lead, 3)
  })

  it('ends a beat after the last word, not at the range edge', () => {
    const plan = planCut(words, 5, 20)
    const end = plan.keep[plan.keep.length - 1].to
    expect(end).toBeCloseTo(12 + DEFAULT_CUT.tail, 2)
  })

  it('never starts before zero', () => {
    expect(planCut(say('go', 0.05), 0, 5).keep[0].from).toBeGreaterThanOrEqual(0)
  })

  it('never runs past the range it was given', () => {
    const plan = planCut(words, 5, 12.1)
    expect(plan.keep[plan.keep.length - 1].to).toBeLessThanOrEqual(12.1)
  })

  it('ignores a wildly long duration on the last word', () => {
    // YouTube runs an event's last word to the event end — here, 9 seconds.
    const trailing: Word[] = [...say('here it', 10, 0.4), { t: 11, d: 9, text: 'is' }]
    const plan = planCut(trailing, 10, 30)
    expect(plan.duration).toBeLessThan(3)
  })

  it('keeps the range as asked when there is no speech in it', () => {
    const plan = planCut(say('elsewhere', 100), 10, 20)
    expect(plan.keep).toEqual([{ from: 10, to: 20 }])
    expect(plan.words).toEqual([])
  })

  it('drops sound cues and speaker marks before snapping', () => {
    const words: Word[] = [
      { t: 10, d: 1, text: '[music]' },
      ...say('>>right then', 12, 0.4),
    ]
    const plan = planCut(words, 9, 20)
    expect(plan.keep[0].from).toBeGreaterThan(11)
    expect(plan.words.map((w) => w.text)).toEqual(['right', 'then'])
  })
})

describe('planCut — dead air', () => {
  // Two sentences with a three-second hole between them.
  const words = [...say('this is the setup', 0, 0.4), ...say('and this is the payoff', 5, 0.4)]

  it('splices out a long pause', () => {
    const plan = planCut(words, 0, 10)
    expect(plan.keep).toHaveLength(2)
    expect(plan.removed).toBeGreaterThan(2)
  })

  it('leaves a beat rather than butt-splicing', () => {
    const [first, second] = planCut(words, 0, 10).keep
    expect(second.from - first.to).toBeGreaterThan(2)
    expect(first.to).toBeGreaterThan(1.6)
  })

  it('keeps an ordinary pause', () => {
    const easy = [...say('a short', 0, 0.4), ...say('breath here', 1.5, 0.4)]
    expect(planCut(easy, 0, 6).keep).toHaveLength(1)
  })

  it('can be told to keep every pause', () => {
    expect(planCut(words, 0, 10, { maxGap: Infinity }).keep).toHaveLength(1)
  })

  it('handles several holes', () => {
    const gappy = [
      ...say('first bit', 0, 0.4),
      ...say('second bit', 6, 0.4),
      ...say('third bit', 12, 0.4),
    ]
    expect(planCut(gappy, 0, 15).keep).toHaveLength(3)
  })

  it('reports a duration matching what it kept', () => {
    const plan = planCut(words, 0, 10)
    expect(plan.duration).toBeCloseTo(total(plan.keep), 5)
  })

  it('produces ranges in order that never overlap', () => {
    const gappy = [...say('a b', 0, 0.4), ...say('c d', 8, 0.4), ...say('e f', 16, 0.4)]
    const { keep } = planCut(gappy, 0, 20)
    for (let i = 1; i < keep.length; i++) {
      expect(keep[i].from).toBeGreaterThanOrEqual(keep[i - 1].to)
    }
    expect(keep.every((k) => k.to > k.from)).toBe(true)
  })
})

describe('retime', () => {
  it('leaves words alone when nothing was removed', () => {
    const words = say('one two three', 10, 0.5)
    const out = retime(words, [{ from: 10, to: 12 }])
    expect(out[0].t).toBe(0)
    expect(out[1].t).toBeCloseTo(0.5, 3)
  })

  it('pulls later words earlier by exactly what was cut', () => {
    const words = [...say('before', 0, 0.4), ...say('after', 5, 0.4)]
    const out = retime(words, [
      { from: 0, to: 0.6 },
      { from: 4.8, to: 5.6 },
    ])
    // "after" starts 0.2s into the second kept range, which begins at 0.6s out.
    expect(out[1].t).toBeCloseTo(0.8, 2)
  })

  it('drops a word that fell inside a removed gap', () => {
    const words = say('keep drop keep', 0, 0.4, 2)
    const out = retime(words, [
      { from: 0, to: 0.5 },
      { from: 4.8, to: 5.4 },
    ])
    expect(out.map((w) => w.text)).toEqual(['keep', 'keep'])
  })

  it('never lets a caption outlive its own kept range', () => {
    const words: Word[] = [{ t: 1, d: 10, text: 'long' }]
    const out = retime(words, [{ from: 1, to: 2 }])
    expect(out[0].d).toBeLessThanOrEqual(1)
  })

  it('never produces a negative time', () => {
    const words = say('a b c', 5, 0.4)
    expect(retime(words, [{ from: 5, to: 7 }]).every((w) => w.t >= 0)).toBe(true)
  })

  it('keeps words in order', () => {
    const words = [...say('a b', 0, 0.4), ...say('c d', 8, 0.4)]
    const out = retime(words, [
      { from: 0, to: 1 },
      { from: 7.8, to: 9 },
    ])
    for (let i = 1; i < out.length; i++) {
      expect(out[i].t).toBeGreaterThanOrEqual(out[i - 1].t)
    }
  })
})

describe('the words a plan returns', () => {
  it('starts the first caption at roughly the lead-in', () => {
    const plan = planCut(say('hello there', 10, 0.4), 5, 20)
    expect(plan.words[0].t).toBeCloseTo(DEFAULT_CUT.lead, 2)
  })

  it('keeps every caption inside the clip', () => {
    const words = [...say('one two three', 0, 0.4), ...say('four five six', 7, 0.4)]
    const plan = planCut(words, 0, 12)
    for (const w of plan.words) {
      expect(w.t + w.d).toBeLessThanOrEqual(plan.duration + 0.01)
    }
  })
})

describe('selectExpr', () => {
  it('builds one between() per kept range, summed', () => {
    const expr = selectExpr([{ from: 10, to: 12 }, { from: 15, to: 18 }], 10)
    expect(expr).toBe('between(t\\,0.000\\,2.000)+between(t\\,5.000\\,8.000)')
  })

  it('escapes its commas, which ffmpeg would read as filter separators', () => {
    expect(selectExpr([{ from: 0, to: 1 }], 0)).not.toMatch(/[^\\],/)
  })

  it('is relative to the seek point, not absolute', () => {
    expect(selectExpr([{ from: 100, to: 101 }], 100)).toContain('0.000')
  })
})

describe('isContinuous', () => {
  it('is true for one range', () => {
    expect(isContinuous([{ from: 0, to: 5 }])).toBe(true)
  })

  it('is false once there is a splice', () => {
    expect(isContinuous([{ from: 0, to: 1 }, { from: 3, to: 5 }])).toBe(false)
  })
})


describe('planning twice', () => {
  it('is not idempotent, which is why the source transcript is required', () => {
    // Documenting the hazard: a rendered clip stores its words on the output
    // timeline with the dead air already gone. Feeding those back in compresses
    // an already-compressed clip and slides every caption out of sync, so
    // `renderOne` takes the transcript rather than the clip's own words.
    const words = [...say('the setup here', 0, 0.4), ...say('and the payoff', 6, 0.4)]

    const first = planCut(words, 0, 10)
    expect(first.keep).toHaveLength(2)

    // The output-timeline words have no long gap left in them at all...
    const again = planCut(first.words, 0, first.duration)
    expect(again.keep).toHaveLength(1)

    // ...so re-planning silently loses the beat that was left at the splice.
    expect(again.duration).toBeLessThan(first.duration)
  })

  it('is safe to plan the same source range twice', () => {
    const words = [...say('the setup here', 0, 0.4), ...say('and the payoff', 6, 0.4)]
    const a = planCut(words, 0, 10)
    const b = planCut(words, 0, 10)
    expect(b.keep).toEqual(a.keep)
    expect(b.words).toEqual(a.words)
  })
})
