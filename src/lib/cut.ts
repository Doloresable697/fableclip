import { cleanWord } from './transcript'
import type { Word } from './types'

/** One stretch of the source that survives into the clip. */
export interface Keep {
  from: number
  to: number
}

export interface CutPlan {
  /** Source ranges to keep, in order, non-overlapping. */
  keep: Keep[]
  /** The clip's words, re-timed onto the *output* timeline. */
  words: Word[]
  /** Length of the finished clip. */
  duration: number
  /** Seconds of silence removed from the middle. */
  removed: number
}

export interface CutOptions {
  /** Start this far before the first word, so the opening consonant survives. */
  lead: number
  /** Hold this long after the last word, so the clip does not end on a cliff. */
  tail: number
  /**
   * A word's stated duration is capped at this. YouTube runs the last word of
   * a caption event to that event's end, which on a pause can be several
   * seconds — believing it would leave the clip trailing off into silence.
   */
  maxWordSeconds: number
  /** A gap longer than this is dead air. Set to Infinity to keep everything. */
  maxGap: number
  /** What a removed gap is replaced by — a beat, rather than a hard splice. */
  keepGap: number
}

export const DEFAULT_CUT: CutOptions = {
  lead: 0.14,
  tail: 0.28,
  maxWordSeconds: 1.2,
  maxGap: 1.4,
  keepGap: 0.32,
}

/**
 * Where each word really ends.
 *
 * A word runs until the next one starts, or for its own stated duration,
 * whichever is shorter. Trusting the stated duration alone is what puts a
 * four-second "word" at the end of a clip.
 */
function wordEnd(words: Word[], i: number, cap: number): number {
  const word = words[i]
  const next = words[i + 1]
  const stated = word.t + Math.min(word.d, cap)
  return next ? Math.min(stated, next.t) : stated
}

/**
 * Turn a chosen range into the ranges actually worth keeping.
 *
 * Two things happen here, and both are the difference between a clip that
 * looks cut and one that looks found:
 *
 *   1. **The edges are snapped to speech.** A clip that opens on half a second
 *      of silence reads as a mistake before a word is said.
 *   2. **Dead air in the middle is removed.** A speaker who pauses for two
 *      seconds mid-answer is normal in a talk and fatal in a short.
 *
 * The words come back re-timed onto the output, because the captions have to
 * follow the cut — removing 2s of silence at 0:08 moves every word after it.
 */
export function planCut(
  allWords: Word[],
  start: number,
  end: number,
  options: Partial<CutOptions> = {},
): CutPlan {
  const opts = { ...DEFAULT_CUT, ...options }

  const inRange: Word[] = []
  for (const raw of allWords) {
    if (raw.t < start - 0.02 || raw.t >= end) continue
    const text = cleanWord(raw.text)
    if (text) inRange.push({ ...raw, text })
  }

  // Nothing to snap to. Keep the range as asked rather than inventing one.
  if (inRange.length === 0) {
    return {
      keep: [{ from: start, to: end }],
      words: [],
      duration: Math.max(0, end - start),
      removed: 0,
    }
  }

  const last = inRange.length - 1
  const from = Math.max(0, Math.min(inRange[0].t - opts.lead, end - 0.5))
  const to = Math.min(end, wordEnd(inRange, last, opts.maxWordSeconds) + opts.tail)

  const keep: Keep[] = []
  let cursor = from

  for (let i = 0; i < last; i++) {
    const gap = inRange[i + 1].t - wordEnd(inRange, i, opts.maxWordSeconds)
    if (gap <= opts.maxGap) continue

    // Leave half a beat on each side of the splice, so it lands on a breath
    // rather than clipping the tail of one word into the head of the next.
    const half = opts.keepGap / 2
    const cutAt = wordEnd(inRange, i, opts.maxWordSeconds) + half
    const resumeAt = inRange[i + 1].t - half

    if (resumeAt - cutAt <= 0.05) continue

    keep.push({ from: cursor, to: cutAt })
    cursor = resumeAt
  }

  keep.push({ from: cursor, to: Math.max(cursor + 0.2, to) })

  return {
    keep,
    words: retime(inRange, keep),
    duration: keep.reduce((n, k) => n + (k.to - k.from), 0),
    removed: Math.max(0, to - from) - keep.reduce((n, k) => n + (k.to - k.from), 0),
  }
}

/**
 * Move words from the source timeline onto the output one.
 *
 * A word is placed by how much kept material precedes it. A word that fell
 * inside a removed gap — which can only be a stray, since gaps are chosen
 * between words — is dropped rather than pinned to the splice.
 */
export function retime(words: Word[], keep: Keep[]): Word[] {
  const offsets: number[] = []
  let elapsed = 0
  for (const range of keep) {
    offsets.push(elapsed - range.from)
    elapsed += range.to - range.from
  }

  const out: Word[] = []

  for (const word of words) {
    const index = keep.findIndex((k) => word.t >= k.from - 0.02 && word.t < k.to)
    if (index === -1) continue

    const at = Math.max(0, word.t + offsets[index])
    // A word may run past the end of its kept range when the splice lands
    // mid-word; clamp so a caption cannot outlive the clip.
    const room = keep[index].to + offsets[index] - at
    const d = Math.max(0.05, Math.min(word.d, room))

    out.push({ t: Number(at.toFixed(3)), d: Number(d.toFixed(3)), text: word.text })
  }

  return out
}

/**
 * The `select` expression that keeps only the wanted ranges.
 *
 * Times are relative to the seek point, because `-ss` before `-i` restamps the
 * output to start at zero. Quoted, because the expression is full of commas
 * and ffmpeg's filter parser would otherwise read each one as the start of
 * another filter.
 */
export function selectExpr(keep: Keep[], origin: number): string {
  return keep
    .map((k) => `between(t\\,${(k.from - origin).toFixed(3)}\\,${(k.to - origin).toFixed(3)})`)
    .join('+')
}

/** True when the plan is a single continuous range and needs no splicing. */
export const isContinuous = (keep: Keep[]): boolean => keep.length <= 1
