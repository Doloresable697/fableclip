import { describe, expect, it } from 'vitest'
import {
  renderWindow,
  toSegments,
  toWindows,
  transcriptText,
  wordRate,
  wordsBetween,
} from '@/lib/transcript'
import type { Word } from '@/lib/types'

/** Words laid end to end, `gap` seconds apart, so timings are predictable. */
function say(text: string, start = 0, each = 0.4, gap = 0): Word[] {
  let t = start
  return text.split(' ').map((word) => {
    const w = { t, d: each, text: word }
    t += each + gap
    return w
  })
}

describe('toSegments', () => {
  it('breaks on a full stop', () => {
    const segments = toSegments(say('one two three. four five six'))
    expect(segments).toHaveLength(2)
    expect(segments[0].text).toBe('one two three.')
  })

  it('does not break on a full stop after only two words', () => {
    // "Dr. Smith went home" must not become "Dr." and the rest.
    const segments = toSegments(say('Dr. Smith went home for the evening'))
    expect(segments).toHaveLength(1)
  })

  it('breaks on a pause once there is enough to break', () => {
    const first = say('one two three four five', 0)
    const second = say('six seven eight nine', 10)
    expect(toSegments([...first, ...second])).toHaveLength(2)
  })

  it('does not break on a pause after only a word or two', () => {
    const segments = toSegments([...say('yes', 0), ...say('and then we continued', 10)])
    expect(segments).toHaveLength(1)
  })

  it('breaks a runaway segment on length alone', () => {
    const long = Array.from({ length: 90 }, (_, i) => ({
      t: i * 0.3,
      d: 0.3,
      text: 'wordy',
    }))
    expect(toSegments(long).length).toBeGreaterThan(1)
  })

  it('treats a speaker change as a hard boundary', () => {
    const words: Word[] = [
      ...say('so what happened next', 0),
      { t: 4, d: 0.4, text: '>>Well' },
      ...say('it fell over', 4.5),
    ]
    const segments = toSegments(words)
    expect(segments).toHaveLength(2)
    expect(segments[1].text.startsWith('Well')).toBe(true)
  })

  it('strips the speaker marker from the text', () => {
    const segments = toSegments([{ t: 0, d: 0.5, text: '>>Hello' }, ...say('there you', 1)])
    expect(transcriptText(segments)).not.toContain('>')
  })

  it('drops sound-effect cues', () => {
    const words: Word[] = [
      { t: 0, d: 1, text: '[applause]' },
      { t: 1, d: 1, text: '(laughter)' },
      ...say('and we begin', 2),
    ]
    expect(transcriptText(toSegments(words))).toBe('and we begin')
  })

  it('spans a segment from its first word to the end of its last', () => {
    const segments = toSegments(say('one two three four', 5, 0.5))
    expect(segments[0].start).toBe(5)
    expect(segments[0].end).toBeCloseTo(7, 5)
  })

  it('returns nothing for no words', () => {
    expect(toSegments([])).toEqual([])
  })

  it('returns nothing when every word is a sound cue', () => {
    expect(toSegments([{ t: 0, d: 1, text: '[music]' }])).toEqual([])
  })
})

describe('toWindows', () => {
  const segments = Array.from({ length: 40 }, (_, i) => ({
    start: i * 10,
    end: i * 10 + 9,
    text: `sentence number ${i} padded out to a reasonable length here`,
    words: [],
  }))

  it('returns one window when everything fits', () => {
    expect(toWindows(segments, 100_000)).toHaveLength(1)
  })

  it('splits into several windows when it does not', () => {
    expect(toWindows(segments, 400, 100).length).toBeGreaterThan(1)
  })

  it('overlaps consecutive windows', () => {
    const windows = toWindows(segments, 400, 150)
    expect(windows[1].first).toBeLessThan(windows[0].first + windows[0].segments.length)
  })

  it('covers every segment', () => {
    const windows = toWindows(segments, 400, 150)
    const last = windows[windows.length - 1]
    expect(last.first + last.segments.length).toBe(segments.length)
  })

  it('always makes progress rather than looping forever', () => {
    // A tiny window with a huge overlap is the setup that can stall.
    const windows = toWindows(segments, 80, 10_000)
    expect(windows.length).toBeLessThan(segments.length + 2)
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].first).toBeGreaterThan(windows[i - 1].first)
    }
  })

  it('carries the time range of what it holds', () => {
    const [window] = toWindows(segments, 100_000)
    expect(window.start).toBe(0)
    expect(window.end).toBe(399)
  })

  it('returns nothing for no segments', () => {
    expect(toWindows([])).toEqual([])
  })
})

describe('renderWindow', () => {
  it('prefixes each line with its absolute segment id', () => {
    const window = {
      first: 12,
      start: 0,
      end: 1,
      segments: [
        { start: 0, end: 1, text: 'first', words: [] },
        { start: 1, end: 2, text: 'second', words: [] },
      ],
    }
    expect(renderWindow(window)).toBe('[12] first\n[13] second')
  })
})

describe('wordsBetween', () => {
  const words = say('zero one two three four five', 0, 1)

  it('rebases the clip so it starts at zero', () => {
    expect(wordsBetween(words, 2, 5)[0].t).toBe(0)
  })

  it('takes the words that begin in the range, not the ones that reach into it', () => {
    // "two" runs from 2 to 3 and so overlaps a clip starting at 2.5, but the
    // viewer hears its tail at best. Including it put a fragment of the
    // previous sentence at the front of every caption.
    expect(wordsBetween(words, 2.5, 4).map((w) => w.text)).toEqual(['three'])
  })

  it('trims a word that runs past the end', () => {
    const clipped = wordsBetween(words, 0, 1.5)
    expect(clipped[1].d).toBeCloseTo(0.5, 5)
  })

  it('returns nothing for an empty range', () => {
    expect(wordsBetween(words, 3, 3)).toEqual([])
  })

  it('never returns a negative time', () => {
    expect(wordsBetween(words, 0, 3).every((w) => w.t >= 0)).toBe(true)
  })

  it('excludes a word that only trails into the clip', () => {
    // The bug this exists for: YouTube runs the last word of a caption event
    // to that event's end, which reaches past where the next event begins. On
    // a real run every clip opened with a stray tail word — "global And it's
    // like how is it possible…" — which also fooled the opening-line scorer.
    const trailing: Word[] = [
      { t: 9, d: 2, text: 'global' },
      { t: 10, d: 0.5, text: 'And' },
      { t: 10.5, d: 0.5, text: "it's" },
    ]
    expect(wordsBetween(trailing, 10, 12).map((w) => w.text)).toEqual(['And', "it's"])
  })

  it('keeps a word starting a hair before the boundary, which is float noise', () => {
    const words: Word[] = [{ t: 9.999, d: 0.5, text: 'first' }]
    expect(wordsBetween(words, 10, 12)).toHaveLength(1)
  })

  it('excludes a word that starts exactly at the end', () => {
    const words: Word[] = [{ t: 12, d: 0.5, text: 'after' }]
    expect(wordsBetween(words, 10, 12)).toEqual([])
  })

  it('strips the speaker marker, which would otherwise reach the screen', () => {
    const words: Word[] = [
      { t: 0, d: 0.5, text: '>>Well' },
      { t: 0.5, d: 0.5, text: 'yes' },
    ]
    expect(wordsBetween(words, 0, 5).map((w) => w.text)).toEqual(['Well', 'yes'])
  })

  it('drops sound cues, which the model never saw either', () => {
    const words: Word[] = [
      { t: 0, d: 1, text: '[applause]' },
      { t: 1, d: 0.5, text: 'thanks' },
    ]
    expect(wordsBetween(words, 0, 5).map((w) => w.text)).toEqual(['thanks'])
  })
})

describe('wordRate', () => {
  it('counts words per second', () => {
    expect(wordRate(say('a b c d', 0, 0.5), 0, 2)).toBe(2)
  })

  it('is zero for a range with no length', () => {
    expect(wordRate(say('a b'), 5, 5)).toBe(0)
  })

  it('is zero for a stretch of silence', () => {
    expect(wordRate(say('a b', 0), 30, 40)).toBe(0)
  })
})
