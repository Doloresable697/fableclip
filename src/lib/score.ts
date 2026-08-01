import type { Dimensions, ScoreBreakdown, ScoreModifier } from './types'

/**
 * How much each judgement is worth.
 *
 * Weighted towards the hook because the format is: a short is decided in its
 * first second, and a brilliant point with a mumbled opening never gets
 * watched. Novelty is worth the least — a familiar idea said well travels
 * further than an original one said badly.
 */
export const WEIGHTS: Record<keyof Dimensions, number> = {
  hook: 0.28,
  payoff: 0.18,
  emotion: 0.16,
  clarity: 0.14,
  quotability: 0.14,
  novelty: 0.1,
}

export function baseScore(dimensions: Dimensions): number {
  let total = 0
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    total += (dimensions[key as keyof Dimensions] / 10) * weight
  }
  return Math.round(total * 100)
}

/**
 * A pronoun with nothing in front of it to resolve against.
 *
 * "It never worked from the start" is a fine sentence inside a talk and a
 * useless first frame — the viewer has no idea what "it" is, and nothing later
 * in the clip tells them. This is the single most common way an otherwise good
 * clip fails, and it is detectable without a model, so it is caught here
 * rather than paid for in tokens.
 */
const VAGUE_REFERENCE = new Set([
  'it', 'its', "it's", 'he', "he's", 'she', "she's", 'they', "they're",
  'them', 'him', 'her', 'this', 'these', 'those', 'their', 'his', 'hers',
  'theirs', 'that',
])

/**
 * Words that merely *sound* like a continuation.
 *
 * Weaker than a dangling pronoun and treated separately, because they are
 * recoverable: "So why is there this level of restraint?" opens on a
 * connective and is still a perfectly good first frame — the question does the
 * work. Lumping these in with pronouns marked exactly that clip down nine
 * points on a real run.
 */
const CONNECTIVES = new Set([
  'and', 'but', 'so', 'because', 'which', 'then', 'also', 'plus',
  'anyway', 'however', 'therefore', 'though', 'although', 'yet', 'or',
])

const FILLERS = new Set([
  'um', 'uh', 'erm', 'ah', 'eh', 'hmm', 'mhm', 'like', 'basically',
  'literally', 'actually', 'sort', 'kind',
])

const ENDS_CLEANLY = /[.!?]["')\]]?\s*$/

export interface ScoreContext {
  start: number
  end: number
  text: string
  /** Words per second across the clip. */
  rate: number
}

/**
 * Length, judged as a curve rather than a range.
 *
 * The sweet spot is real and narrow: under about twelve seconds there is not
 * enough to say, and past ninety the format stops being a short. The middle
 * gets a bonus rather than merely avoiding a penalty, so a well-sized clip can
 * out-rank a longer one the model liked slightly more.
 */
export function durationModifier(seconds: number): ScoreModifier {
  if (seconds < 12) {
    return { label: 'too short', delta: -14, detail: `${seconds.toFixed(0)}s — not enough to land` }
  }
  if (seconds < 18) {
    return { label: 'short', delta: -5, detail: `${seconds.toFixed(0)}s` }
  }
  if (seconds <= 48) {
    return { label: 'well sized', delta: 5, detail: `${seconds.toFixed(0)}s` }
  }
  if (seconds <= 70) {
    return { label: 'on the long side', delta: 0, detail: `${seconds.toFixed(0)}s` }
  }
  if (seconds <= 95) {
    return { label: 'long', delta: -6, detail: `${seconds.toFixed(0)}s` }
  }
  return { label: 'too long', delta: -13, detail: `${seconds.toFixed(0)}s — past the format` }
}

/** Speech that is too slow reads as dead air; too fast is unfollowable. */
export function paceModifier(rate: number): ScoreModifier {
  const wps = `${rate.toFixed(1)} words/sec`

  if (rate < 1.4) return { label: 'slow', delta: -8, detail: `${wps} — long gaps` }
  if (rate < 2.0) return { label: 'unhurried', delta: -2, detail: wps }
  if (rate <= 3.6) return { label: 'good pace', delta: 4, detail: wps }
  if (rate <= 4.6) return { label: 'fast', delta: 0, detail: wps }
  return { label: 'rushed', delta: -5, detail: wps }
}

/** Does the first line work with nothing in front of it? */
export function openingModifier(text: string): ScoreModifier {
  const first = text.trim().split(/\s+/)[0] ?? ''
  const word = first.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '')

  const firstSentence = text.split(/[.!?]/)[0] ?? ''
  const opensOnQuestion = text.slice(0, firstSentence.length + 1).includes('?')
  const opensOnNumber = /\d/.test(firstSentence)

  // A pronoun is unrecoverable: a question mark later in the sentence still
  // does not tell the viewer who "he" is, so no bonus rescues this.
  if (VAGUE_REFERENCE.has(word)) {
    return {
      label: 'opens on an unexplained pronoun',
      delta: -9,
      detail: `starts on "${first}" — nothing in the clip says what that refers to`,
    }
  }

  if (CONNECTIVES.has(word)) {
    return opensOnQuestion
      ? {
          label: 'opens on a question',
          delta: 2,
          detail: `"${first}" is a soft start, but the question carries it`,
        }
      : {
          label: 'opens mid-thought',
          delta: -6,
          detail: `starts on "${first}" — reads as a continuation of something`,
        }
  }

  if (opensOnQuestion) {
    return { label: 'opens on a question', delta: 5, detail: 'questions hold attention' }
  }
  if (opensOnNumber) {
    return { label: 'opens on a number', delta: 3, detail: 'specifics earn the watch' }
  }

  return { label: 'clean opening', delta: 0, detail: 'stands on its own' }
}

/** A clip that stops mid-sentence feels like a mistake, whatever it contains. */
export function endingModifier(text: string): ScoreModifier {
  return ENDS_CLEANLY.test(text)
    ? { label: 'lands', delta: 3, detail: 'finishes its sentence' }
    : { label: 'cuts off', delta: -7, detail: 'ends mid-sentence' }
}

/** Um, uh, like. Measurable, and nobody wants a clip made of it. */
export function fillerModifier(text: string): ScoreModifier {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)

  if (words.length === 0) {
    return { label: 'filler', delta: 0, detail: 'no speech' }
  }

  const hits = words.filter((w) => FILLERS.has(w)).length
  const share = hits / words.length
  const pct = `${(share * 100).toFixed(0)}% filler`

  if (share > 0.08) return { label: 'heavy filler', delta: -8, detail: pct }
  if (share > 0.045) return { label: 'some filler', delta: -3, detail: pct }
  return { label: 'tight delivery', delta: 2, detail: pct }
}

/**
 * The number on the card.
 *
 * The model supplies taste and the modifiers supply the things taste is bad
 * at — length, pace, whether the first word is "and". Every contribution is
 * kept and shown in the UI, because a score with no visible reasoning is a
 * horoscope and nobody should trust one.
 */
export function scoreClip(
  dimensions: Dimensions,
  context: ScoreContext,
): ScoreBreakdown {
  const base = baseScore(dimensions)

  const modifiers = [
    durationModifier(context.end - context.start),
    paceModifier(context.rate),
    openingModifier(context.text),
    endingModifier(context.text),
    fillerModifier(context.text),
  ]

  const total = modifiers.reduce((sum, m) => sum + m.delta, base)

  return { base, modifiers, total: Math.min(100, Math.max(0, Math.round(total))) }
}

/** How the score reads in one word, for the badge on the card. */
export function scoreLabel(score: number): string {
  if (score >= 80) return 'exceptional'
  if (score >= 68) return 'strong'
  if (score >= 55) return 'promising'
  if (score >= 40) return 'middling'
  return 'weak'
}
