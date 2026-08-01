import { describe, expect, it } from 'vitest'
import {
  baseScore,
  durationModifier,
  endingModifier,
  fillerModifier,
  openingModifier,
  paceModifier,
  scoreClip,
  scoreLabel,
  WEIGHTS,
} from '@/lib/score'
import type { Dimensions } from '@/lib/types'

const flat = (n: number): Dimensions => ({
  hook: n,
  emotion: n,
  clarity: n,
  payoff: n,
  quotability: n,
  novelty: n,
})

describe('WEIGHTS', () => {
  it('sums to one, or the base score is not out of 100', () => {
    const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(1, 10)
  })

  it('weights the hook above everything else', () => {
    const others = Object.entries(WEIGHTS).filter(([k]) => k !== 'hook')
    expect(others.every(([, w]) => w < WEIGHTS.hook)).toBe(true)
  })
})

describe('baseScore', () => {
  it('gives a perfect card 100', () => {
    expect(baseScore(flat(10))).toBe(100)
  })

  it('gives an empty card 0', () => {
    expect(baseScore(flat(0))).toBe(0)
  })

  it('gives a middling card about half', () => {
    expect(baseScore(flat(5))).toBe(50)
  })

  it('moves more for the hook than for novelty', () => {
    const withHook = baseScore({ ...flat(5), hook: 10 })
    const withNovelty = baseScore({ ...flat(5), novelty: 10 })
    expect(withHook).toBeGreaterThan(withNovelty)
  })
})

describe('durationModifier', () => {
  it('penalises a clip too short to land', () => {
    expect(durationModifier(8).delta).toBeLessThan(-10)
  })

  it('rewards the sweet spot', () => {
    expect(durationModifier(32).delta).toBeGreaterThan(0)
  })

  it('is neutral just past the sweet spot', () => {
    expect(durationModifier(60).delta).toBe(0)
  })

  it('penalises anything past the format', () => {
    expect(durationModifier(140).delta).toBeLessThan(-10)
  })

  it('gets worse as the clip gets longer', () => {
    expect(durationModifier(120).delta).toBeLessThan(durationModifier(80).delta)
  })

  it('says how long the clip actually is', () => {
    expect(durationModifier(37.4).detail).toContain('37s')
  })
})

describe('paceModifier', () => {
  it('penalises dead air', () => {
    expect(paceModifier(0.8).delta).toBeLessThan(0)
  })

  it('rewards a normal speaking pace', () => {
    expect(paceModifier(2.8).delta).toBeGreaterThan(0)
  })

  it('penalises an unfollowable rush', () => {
    expect(paceModifier(6).delta).toBeLessThan(0)
  })

  it('is neutral for merely brisk speech', () => {
    expect(paceModifier(4).delta).toBe(0)
  })
})

describe('openingModifier', () => {
  it('penalises a clip that opens on a conjunction', () => {
    expect(openingModifier('And that is the whole problem.').delta).toBeLessThan(0)
  })

  it('penalises a clip that opens on an unexplained pronoun', () => {
    expect(openingModifier('It never worked from the start.').delta).toBeLessThan(0)
  })

  it('punishes a dangling pronoun harder than a connective', () => {
    const pronoun = openingModifier('It never worked from the start.').delta
    const connective = openingModifier('But nobody wanted to say so.').delta
    expect(pronoun).toBeLessThan(connective)
  })

  it('lets a question rescue a connective opening', () => {
    // Measured on a real run: "So why is there this level of restraint from
    // Trump?" is a perfectly good first frame and was being docked nine points
    // for starting on "So".
    const rescued = openingModifier('So why is there this level of restraint from Trump?')
    expect(rescued.delta).toBeGreaterThan(0)
  })

  it('does not let a question rescue a dangling pronoun', () => {
    // No amount of question mark tells the viewer who "he" is.
    expect(openingModifier('He never said why, did he?').delta).toBeLessThan(0)
  })

  it('still prefers a clean question opening to a rescued one', () => {
    const clean = openingModifier('Why does nobody say this?')
    const rescued = openingModifier('So why does nobody say this?')
    expect(clean.delta).toBeGreaterThan(rescued.delta)
  })

  it('names the word that caused the penalty', () => {
    expect(openingModifier('And so on.').detail).toContain('"And"')
  })

  it('rewards opening on a question', () => {
    expect(openingModifier('Why does nobody say this? Because it costs money.').delta).toBeGreaterThan(0)
  })

  it('rewards opening on a number', () => {
    expect(openingModifier('Ninety per cent of these fail in year 2.').delta).toBeGreaterThan(0)
  })

  it('is neutral for an ordinary clean opening', () => {
    expect(openingModifier('Nobody enjoys being told that.').delta).toBe(0)
  })

  it('ignores case and leading punctuation', () => {
    expect(openingModifier('"and then it broke."').delta).toBeLessThan(0)
  })

  it('does not treat a later question mark as an opening question', () => {
    const text = 'The system works fine. But does it scale?'
    expect(openingModifier(text).label).not.toBe('opens on a question')
  })

  it('survives an empty clip', () => {
    expect(() => openingModifier('')).not.toThrow()
  })
})

describe('endingModifier', () => {
  it('rewards a finished sentence', () => {
    expect(endingModifier('That is the whole point.').delta).toBeGreaterThan(0)
  })

  it('penalises a clip that stops mid-sentence', () => {
    expect(endingModifier('and the reason for that is').delta).toBeLessThan(0)
  })

  it('accepts a question mark as an ending', () => {
    expect(endingModifier('So what do we do?').delta).toBeGreaterThan(0)
  })

  it('accepts a full stop inside a closing quote', () => {
    expect(endingModifier('He said "no."').delta).toBeGreaterThan(0)
  })
})

describe('fillerModifier', () => {
  it('rewards tight delivery', () => {
    expect(fillerModifier('The answer is that nobody checked the numbers').delta).toBeGreaterThan(0)
  })

  it('penalises a clip made mostly of um and uh', () => {
    expect(fillerModifier('um uh so like um basically uh yeah').delta).toBeLessThan(-5)
  })

  it('reports the share as a percentage', () => {
    expect(fillerModifier('um one two three').detail).toContain('%')
  })

  it('does not divide by zero on an empty clip', () => {
    expect(fillerModifier('').delta).toBe(0)
  })
})

describe('scoreClip', () => {
  const context = {
    start: 0,
    end: 32,
    text: 'Nobody checked the numbers for three years running. That is the whole story.',
    rate: 2.6,
  }

  it('keeps the base and every modifier for the UI to show', () => {
    const breakdown = scoreClip(flat(7), context)
    expect(breakdown.base).toBe(70)
    expect(breakdown.modifiers).toHaveLength(5)
  })

  it('adds the modifiers to the base', () => {
    const breakdown = scoreClip(flat(7), context)
    const sum = breakdown.modifiers.reduce((n, m) => n + m.delta, breakdown.base)
    expect(breakdown.total).toBe(Math.min(100, Math.max(0, Math.round(sum))))
  })

  it('cannot exceed 100 however good everything is', () => {
    expect(scoreClip(flat(10), context).total).toBe(100)
  })

  it('cannot fall below 0 however bad everything is', () => {
    const bad = scoreClip(flat(0), {
      start: 0,
      end: 4,
      text: 'and um uh like so',
      rate: 0.4,
    })
    expect(bad.total).toBe(0)
  })

  it('ranks a well-formed clip above a badly formed one with the same taste scores', () => {
    const good = scoreClip(flat(6), context)
    const bad = scoreClip(flat(6), {
      start: 0,
      end: 8,
      text: 'and it was, um, sort of like the thing we',
      rate: 5.5,
    })
    expect(good.total).toBeGreaterThan(bad.total)
  })

  it('returns a whole number, because it is shown as one', () => {
    expect(Number.isInteger(scoreClip(flat(7), context).total)).toBe(true)
  })
})

describe('scoreLabel', () => {
  it('names each band', () => {
    expect(scoreLabel(92)).toBe('exceptional')
    expect(scoreLabel(70)).toBe('strong')
    expect(scoreLabel(60)).toBe('promising')
    expect(scoreLabel(45)).toBe('middling')
    expect(scoreLabel(10)).toBe('weak')
  })
})
