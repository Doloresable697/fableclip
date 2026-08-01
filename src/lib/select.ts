import { extractJson } from './json'
import type { Dimensions, Segment } from './types'

/** A clip as the model described it, before any of it is believed. */
export interface RawClip {
  startId: number
  endId: number
  title: string
  hook: string
  reason: string
  startQuote: string
  endQuote: string
  dimensions: Dimensions
}

/** A clip once it has been tied to real positions in the transcript. */
export interface Candidate {
  startSeg: number
  endSeg: number
  start: number
  end: number
  title: string
  hook: string
  reason: string
  dimensions: Dimensions
}

const DIMENSION_KEYS: Array<keyof Dimensions> = [
  'hook',
  'emotion',
  'clarity',
  'payoff',
  'quotability',
  'novelty',
]

const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v.trim() : fallback

/**
 * A dimension the model left out, or wrote as "high", becomes 5 — the middle.
 *
 * Dropping the clip instead would be worse: one missing field out of six is
 * the model being sloppy about JSON, not the model having nothing to say, and
 * a 7B model gets one field wrong often enough that strictness here throws
 * away most of the answer.
 */
export function normalizeDimensions(value: unknown): Dimensions {
  const raw = (value ?? {}) as Record<string, unknown>
  const out = {} as Dimensions

  for (const key of DIMENSION_KEYS) {
    const n = Number(raw[key])
    out[key] = Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : 5
  }

  return out
}

export function parseClipsResponse(text: string): RawClip[] {
  const doc = extractJson<unknown>(text)

  // Models answer `{"clips":[...]}`, or a bare array, or occasionally a single
  // object. All three mean the same thing.
  const list = Array.isArray(doc)
    ? doc
    : Array.isArray((doc as { clips?: unknown })?.clips)
      ? ((doc as { clips: unknown[] }).clips)
      : [doc]

  return list
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      startId: Number(item.startId ?? item.start_id ?? item.start ?? NaN),
      endId: Number(item.endId ?? item.end_id ?? item.end ?? NaN),
      title: str(item.title, 'Untitled clip'),
      hook: str(item.hook),
      reason: str(item.reason),
      startQuote: str(item.startQuote ?? item.start_quote),
      endQuote: str(item.endQuote ?? item.end_quote),
      dimensions: normalizeDimensions(item.scores ?? item.dimensions),
    }))
}

const tokens = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)

/**
 * Find the segment a quote came from.
 *
 * The fallback for when a model ignores the id format, which small ones do.
 * Scoring is the share of the quote's words that appear in the segment, so a
 * quote the model paraphrased still lands — but a quote it invented matches
 * nothing above the threshold and the candidate is dropped rather than placed
 * somewhere arbitrary.
 */
export function matchQuote(
  quote: string,
  segments: Segment[],
  threshold = 0.6,
): number {
  const want = tokens(quote)
  if (want.length === 0) return -1

  let best = -1
  let bestScore = 0

  for (let i = 0; i < segments.length; i++) {
    const have = new Set(tokens(segments[i].text))
    const hits = want.filter((w) => have.has(w)).length
    const score = hits / want.length

    if (score > bestScore) {
      bestScore = score
      best = i
    }
  }

  return bestScore >= threshold ? best : -1
}

/**
 * Turn a model's answer into a real span of transcript, or nothing.
 *
 * Ids first, because an integer the model copied off the page is not a guess.
 * Quotes second, for the models that answer in their own format regardless of
 * what was asked. If neither resolves, the candidate is discarded — inventing
 * a position would produce a clip of a moment nobody chose.
 */
export function resolveRange(
  raw: RawClip,
  segments: Segment[],
): { startSeg: number; endSeg: number } | null {
  const valid = (n: number): boolean =>
    Number.isInteger(n) && n >= 0 && n < segments.length

  let startSeg = valid(raw.startId) ? raw.startId : matchQuote(raw.startQuote, segments)
  let endSeg = valid(raw.endId) ? raw.endId : matchQuote(raw.endQuote, segments)

  if (startSeg < 0 && endSeg < 0) return null

  // One end resolved. A clip anchored at one end is still a real moment; give
  // it a default length rather than throwing the whole candidate away.
  if (startSeg < 0) startSeg = Math.max(0, endSeg - 6)
  if (endSeg < 0) endSeg = Math.min(segments.length - 1, startSeg + 6)

  if (endSeg < startSeg) [startSeg, endSeg] = [endSeg, startSeg]

  return { startSeg, endSeg }
}

/**
 * Grow or shrink a span until it fits the requested length.
 *
 * Growth adds whole segments and prefers to add them at the end, because
 * extending forwards keeps the opening line — which is the thing the model
 * judged the hook on. Shrinking also comes off the end, for the same reason,
 * down to a floor of one segment so a clip can never become empty.
 */
export function fitDuration(
  startSeg: number,
  endSeg: number,
  segments: Segment[],
  min: number,
  max: number,
): { startSeg: number; endSeg: number } {
  let lo = startSeg
  let hi = endSeg

  const span = (): number => segments[hi].end - segments[lo].start

  // Forwards until it fits, or until the transcript runs out.
  while (span() < min && hi < segments.length - 1) hi++

  // Only then backwards — which happens for a moment near the end of the
  // video, where there is nothing left in front of it to take.
  while (span() < min && lo > 0) lo--

  while (span() > max && hi > lo) hi--

  return { startSeg: lo, endSeg: hi }
}

/**
 * Two windows overlap, so the same great moment gets found twice. Keep one.
 *
 * "Overlapping" is measured against the shorter of the pair: a 25-second clip
 * sitting entirely inside a 60-second one is the same moment told at two
 * lengths, and shipping both wastes a slot on a page of six.
 */
export function mergeOverlapping<T extends { start: number; end: number; score: number }>(
  clips: T[],
  ratio = 0.4,
): T[] {
  const sorted = [...clips].sort((a, b) => b.score - a.score)
  const kept: T[] = []

  for (const clip of sorted) {
    const clash = kept.some((k) => {
      const overlap = Math.min(k.end, clip.end) - Math.max(k.start, clip.start)
      if (overlap <= 0) return false

      const shorter = Math.min(k.end - k.start, clip.end - clip.start)
      return shorter > 0 && overlap / shorter >= ratio
    })

    if (!clash) kept.push(clip)
  }

  return kept.sort((a, b) => a.start - b.start)
}

/**
 * The full journey from one model response to placed candidates.
 *
 * Anything that cannot be tied to the transcript is dropped here, quietly and
 * on purpose: a window that produces two usable clips out of four suggestions
 * is a good window, and failing the whole job over the other two would mean
 * one sloppy response costs the user the entire video.
 */
export function toCandidates(
  raws: RawClip[],
  segments: Segment[],
  min: number,
  max: number,
): Candidate[] {
  const out: Candidate[] = []

  for (const raw of raws) {
    const range = resolveRange(raw, segments)
    if (!range) continue

    const fitted = fitDuration(range.startSeg, range.endSeg, segments, min, max)
    const start = segments[fitted.startSeg].start
    const end = segments[fitted.endSeg].end

    if (end - start < 4) continue

    out.push({
      startSeg: fitted.startSeg,
      endSeg: fitted.endSeg,
      start,
      end,
      title: raw.title,
      hook: raw.hook,
      reason: raw.reason,
      dimensions: raw.dimensions,
    })
  }

  return out
}
