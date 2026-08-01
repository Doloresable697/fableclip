import type { Segment, Word } from './types'

/**
 * YouTube marks a change of speaker with `>>` at the start of a line. It is a
 * useful boundary and terrible caption text, so it is used and then removed.
 */
const SPEAKER_MARK = /^>>+\s*/

/** Sound effects and music cues in captions: "[applause]", "(laughter)". */
const NON_SPEECH = /^[[(][^\])]*[\])]$/

const ENDS_SENTENCE = /[.!?]["')\]]?$/

/**
 * Fold words into sentence-ish segments.
 *
 * Three things end a segment, in the order they are worth trusting:
 *
 *   1. Sentence punctuation. YouTube's machine captions are punctuated — a
 *      38-minute talk came back with 325 full stops — so this does most of
 *      the work.
 *   2. A pause. Whisper on a language model with no punctuation, or a speaker
 *      who trails off, leaves silence as the only signal there was a break.
 *   3. Length. Nothing downstream benefits from a 400-character "sentence",
 *      and one runaway segment distorts every window it lands in.
 */
export function toSegments(words: Word[], pauseSeconds = 0.65): Segment[] {
  const segments: Segment[] = []
  let current: Word[] = []

  const flush = (): void => {
    if (current.length === 0) return

    const text = current
      .map((w) => w.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()

    if (text) {
      segments.push({
        start: current[0].t,
        end: current[current.length - 1].t + current[current.length - 1].d,
        text,
        words: current,
      })
    }
    current = []
  }

  for (const raw of words) {
    const text = raw.text.replace(SPEAKER_MARK, '').trim()
    // A speaker change is a hard boundary even mid-sentence.
    if (SPEAKER_MARK.test(raw.text)) flush()

    if (!text || NON_SPEECH.test(text)) continue

    const word: Word = { ...raw, text }
    const previous = current[current.length - 1]

    if (previous) {
      const gap = word.t - (previous.t + previous.d)
      const chars = current.reduce((n, w) => n + w.text.length + 1, 0)

      if (
        (ENDS_SENTENCE.test(previous.text) && current.length >= 3) ||
        (gap > pauseSeconds && current.length >= 4) ||
        chars > 260
      ) {
        flush()
      }
    }

    current.push(word)
  }

  flush()
  return segments
}

/**
 * A window of transcript small enough to ask a model about.
 *
 * `first` is the index of the window's first segment in the full list, which
 * is what turns a model's answer back into a position in the video.
 */
export interface Window {
  first: number
  segments: Segment[]
  start: number
  end: number
}

/**
 * Cut the transcript into overlapping windows.
 *
 * The overlap is not politeness — it is the fix for the one failure this
 * design has. A clip that straddles a window boundary is invisible to both
 * requests, and the best moment in a talk has no obligation to land in the
 * middle of a chunk. Overlapping by a couple of minutes means every moment is
 * seen whole at least once, and `mergeOverlapping` in select.ts throws away
 * the duplicates that produces.
 */
export function toWindows(
  segments: Segment[],
  maxChars = windowChars(),
  overlapChars = Math.floor(windowChars() / 4),
): Window[] {
  if (segments.length === 0) return []

  const windows: Window[] = []
  let first = 0

  while (first < segments.length) {
    let chars = 0
    let last = first

    while (last < segments.length && chars < maxChars) {
      chars += segments[last].text.length + 12 // roughly the id prefix
      last++
    }

    const slice = segments.slice(first, last)
    windows.push({
      first,
      segments: slice,
      start: slice[0].start,
      end: slice[slice.length - 1].end,
    })

    if (last >= segments.length) break

    // Step back far enough to re-show `overlapChars` of the tail.
    let back = last
    let overlap = 0
    while (back > first + 1 && overlap < overlapChars) {
      back--
      overlap += segments[back].text.length + 12
    }
    first = back
  }

  return windows
}

function windowChars(): number {
  const configured = Number(process.env.LLM_WINDOW_CHARS)
  return Number.isFinite(configured) && configured > 500 ? configured : 9000
}

/**
 * The window as the model sees it.
 *
 * Every line is prefixed with the segment's absolute index, because that index
 * is what the model is asked to point at. Giving it timestamps instead invites
 * arithmetic, and small models cannot do arithmetic on timestamps — they
 * return plausible-looking numbers for moments that do not exist.
 */
export function renderWindow(window: Window): string {
  return window.segments
    .map((seg, i) => `[${window.first + i}] ${seg.text}`)
    .join('\n')
}

export const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, n))

/**
 * Caption text for one word, or null if it should not be shown at all.
 *
 * The same rules `toSegments` applies, exported so the two cannot drift. A
 * clip's captions are cut from the raw transcript rather than from segments —
 * the raw list is what a re-trim in the editor has to work against — so
 * without this, `>>Well` and `[applause]` reach the screen even though the
 * model was never shown them.
 */
export function cleanWord(text: string): string | null {
  const cleaned = text.replace(SPEAKER_MARK, '').trim()
  if (!cleaned || NON_SPEECH.test(cleaned)) return null
  return cleaned
}

/**
 * The words inside a time range, re-based so the clip starts at zero.
 *
 * A word belongs to the clip if it *begins* inside it, not if it merely
 * overlaps. Overlap is the obvious rule and it is wrong: YouTube runs the last
 * word of a caption event to the event's end, which routinely reaches past the
 * start of the next one — so every clip opened with a stray tail word from the
 * sentence before it. "global And it's like how is it possible…" was a real
 * caption, and the leading fragment also fooled the opening-line scorer.
 */
export function wordsBetween(words: Word[], start: number, end: number): Word[] {
  const out: Word[] = []

  for (const word of words) {
    // A hair of tolerance, because the clip boundary is itself a word's start
    // time and floating point does not always agree with itself about that.
    if (word.t < start - 0.02 || word.t >= end) continue

    const text = cleanWord(word.text)
    if (!text) continue

    const at = Math.max(0, word.t - start)
    const d = Math.min(word.d, end - Math.max(word.t, start))
    if (d <= 0.01) continue

    out.push({ t: at, d, text })
  }

  return out
}

export const transcriptText = (segments: Segment[]): string =>
  segments.map((s) => s.text).join(' ')

/** Words per second across a range — the pace signal the scorer uses. */
export function wordRate(words: Word[], start: number, end: number): number {
  const span = end - start
  if (span <= 0) return 0
  return words.filter((w) => w.t >= start && w.t < end).length / span
}
