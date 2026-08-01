import type { Transcript, TranscriptSource, Word } from './types'

/**
 * YouTube's `json3` caption format.
 *
 * Only the fields that matter are typed. `segs[].tOffsetMs` is the interesting
 * one: on a machine-generated track it carries the offset of each word from
 * the event start, which is a full word-level alignment nobody has to compute.
 */
interface Json3Seg {
  utf8?: unknown
  tOffsetMs?: unknown
}

interface Json3Event {
  tStartMs?: unknown
  dDurationMs?: unknown
  segs?: unknown
  /**
   * Rolling captions. YouTube emits an `aAppend` event carrying a lone "\n"
   * between real ones; treating those as content puts a blank line — and, on
   * some tracks, a repeat of the previous line — into the transcript.
   */
  aAppend?: unknown
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/**
 * Words out of a YouTube `json3` caption file.
 *
 * Two shapes arrive under the same extension and they are not equally useful:
 *
 *   - A machine-generated track splits every event into one seg per word, each
 *     with its own `tOffsetMs`. Real alignment, free, in about a second.
 *   - A creator-uploaded track has one seg per event holding a whole line, and
 *     no offsets at all. Still worth having — the text is better — but the
 *     word times have to be invented.
 *
 * Both come back as the same `Word[]`; `wordTimed` says which happened.
 */
export function parseJson3(text: string): { words: Word[]; wordTimed: boolean } {
  let doc: { events?: unknown }
  try {
    doc = JSON.parse(text) as { events?: unknown }
  } catch {
    return { words: [], wordTimed: false }
  }

  const events = Array.isArray(doc.events) ? (doc.events as Json3Event[]) : []
  const words: Word[] = []
  let sawOffsets = false

  for (const event of events) {
    // A caption file is downloaded from the internet, so "events is an array"
    // is the only thing that has been established about it.
    if (!event || typeof event !== 'object' || event.aAppend) continue

    const start = num(event.tStartMs)
    if (start === null) continue

    const segs = Array.isArray(event.segs) ? (event.segs as Json3Seg[]) : []
    const duration = num(event.dDurationMs) ?? 0

    const pieces = segs
      .map((seg) => ({
        text: typeof seg.utf8 === 'string' ? seg.utf8 : '',
        offset: num(seg.tOffsetMs),
      }))
      .filter((p) => p.text.trim().length > 0)

    if (pieces.length === 0) continue

    // One seg per word, with offsets: the alignment is already done.
    if (pieces.length > 1 || pieces[0].offset !== null) {
      sawOffsets = true

      for (let i = 0; i < pieces.length; i++) {
        const at = start + (pieces[i].offset ?? 0)
        // The last word of an event has no following offset to end against,
        // so it runs to the event's own end.
        const next =
          i + 1 < pieces.length
            ? start + (pieces[i + 1].offset ?? 0)
            : start + duration

        words.push({
          t: at / 1000,
          d: Math.max(0.05, (next - at) / 1000),
          text: pieces[i].text.trim(),
        })
      }
      continue
    }

    // One seg holding a whole line: split it and share the time out.
    words.push(
      ...spreadWords(pieces[0].text, start / 1000, Math.max(0.2, duration / 1000)),
    )
  }

  return { words: dedupe(words), wordTimed: sawOffsets }
}

/**
 * Split a line into words and give each a slice of the line's duration,
 * weighted by length.
 *
 * Equal slices look wrong the moment a line mixes "a" with "extraordinarily" —
 * the highlight sits on the short word and races through the long one. Weighting
 * by character count is not phonetics, but it tracks speech closely enough that
 * the highlight lands on the word being said.
 */
export function spreadWords(line: string, start: number, duration: number): Word[] {
  const tokens = line.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []

  const weights = tokens.map((w) => Math.max(1, w.replace(/[^\p{L}\p{N}]/gu, '').length))
  const total = weights.reduce((a, b) => a + b, 0)

  const words: Word[] = []
  let at = start

  for (let i = 0; i < tokens.length; i++) {
    const d = (duration * weights[i]) / total
    words.push({ t: at, d: Math.max(0.05, d), text: tokens[i] })
    at += d
  }

  return words
}

/**
 * Rolling captions repeat.
 *
 * A track written for on-screen display re-sends the previous line with each
 * new one so the viewer sees two rows at once. Read literally, that produces a
 * transcript where every sentence appears twice — which wrecks both the word
 * count and anything the model is asked to find in it.
 *
 * A word is a repeat when the same text was already recorded at effectively
 * the same moment. Genuinely repeated speech ("no, no, no") is seconds apart
 * and survives.
 */
function dedupe(words: Word[]): Word[] {
  const sorted = [...words].sort((a, b) => a.t - b.t)
  const out: Word[] = []

  for (const word of sorted) {
    const previous = out[out.length - 1]
    if (
      previous &&
      previous.text === word.text &&
      Math.abs(previous.t - word.t) < 0.05
    ) {
      continue
    }
    out.push(word)
  }

  return out
}

/**
 * WebVTT, for the case where a provider offers no json3.
 *
 * VTT has no word timing at all, so every line is spread. It exists as a
 * fallback, not a preference.
 */
export function parseVtt(text: string): Word[] {
  const words: Word[] = []
  const lines = text.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const cue = lines[i].match(
      /^\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{3}|\d{1,2}:\d{2}[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{3}|\d{1,2}:\d{2}[.,]\d{3})/,
    )
    if (!cue) continue

    const start = vttTime(cue[1])
    const end = vttTime(cue[2])

    const body: string[] = []
    for (let j = i + 1; j < lines.length && lines[j].trim() !== ''; j++) {
      body.push(lines[j])
    }

    // VTT cues can carry inline timing and karaoke tags. Strip the markup;
    // the tags that survive into the text render as literal "<c>" on screen.
    const clean = body
      .join(' ')
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim()

    if (clean) words.push(...spreadWords(clean, start, Math.max(0.2, end - start)))
  }

  return dedupe(words)
}

function vttTime(stamp: string): number {
  const parts = stamp.replace(',', '.').split(':').map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] ?? 0
}

/** Wrap parsed words as a transcript, or report that there was nothing usable. */
export function toTranscript(
  source: TranscriptSource,
  lang: string,
  words: Word[],
  wordTimed: boolean,
): Transcript {
  return {
    source: words.length > 0 ? source : 'none',
    lang,
    words,
    wordTimed: wordTimed && words.length > 0,
  }
}
