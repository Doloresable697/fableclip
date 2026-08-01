import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseJson3, parseVtt, spreadWords, toTranscript } from '@/lib/captions'

const fixture = (name: string): string =>
  readFileSync(join(__dirname, 'fixtures', name), 'utf8')

describe('parseJson3 — machine captions', () => {
  const doc = JSON.stringify({
    events: [
      {
        tStartMs: 1000,
        dDurationMs: 2000,
        segs: [
          { utf8: 'Hello' },
          { utf8: ' there', tOffsetMs: 500 },
          { utf8: ' friend', tOffsetMs: 1200 },
        ],
      },
    ],
  })

  it('reads a word-level offset as an absolute time', () => {
    const { words } = parseJson3(doc)
    expect(words.map((w) => [w.text, w.t])).toEqual([
      ['Hello', 1],
      ['there', 1.5],
      ['friend', 2.2],
    ])
  })

  it('runs each word up to the next one', () => {
    const { words } = parseJson3(doc)
    expect(words[0].d).toBeCloseTo(0.5, 5)
    expect(words[1].d).toBeCloseTo(0.7, 5)
  })

  it('ends the last word at the event end, having nothing to follow', () => {
    const { words } = parseJson3(doc)
    expect(words[2].d).toBeCloseTo(0.8, 5)
  })

  it('reports that the timing is real', () => {
    expect(parseJson3(doc).wordTimed).toBe(true)
  })
})

describe('parseJson3 — creator-uploaded captions', () => {
  const doc = JSON.stringify({
    events: [
      {
        tStartMs: 0,
        dDurationMs: 4000,
        segs: [{ utf8: 'a considerably longer word here' }],
      },
    ],
  })

  it('splits the line into words', () => {
    expect(parseJson3(doc).words.map((w) => w.text)).toEqual([
      'a',
      'considerably',
      'longer',
      'word',
      'here',
    ])
  })

  it('admits the timing was invented', () => {
    expect(parseJson3(doc).wordTimed).toBe(false)
  })

  it('gives a long word more time than a short one', () => {
    const words = parseJson3(doc).words
    expect(words[1].d).toBeGreaterThan(words[0].d * 3)
  })

  it('lays the words out in order without gaps', () => {
    const words = parseJson3(doc).words
    for (let i = 1; i < words.length; i++) {
      expect(words[i].t).toBeCloseTo(words[i - 1].t + words[i - 1].d, 5)
    }
  })
})

describe('parseJson3 — rolling caption artefacts', () => {
  it('drops aAppend events, which carry only a newline', () => {
    const doc = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'one' }] },
        { tStartMs: 500, dDurationMs: 500, aAppend: 1, segs: [{ utf8: '\n' }] },
        { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'two' }] },
      ],
    })
    expect(parseJson3(doc).words.map((w) => w.text)).toEqual(['one', 'two'])
  })

  it('drops a word repeated at the same instant', () => {
    const doc = JSON.stringify({
      events: [
        { tStartMs: 1000, dDurationMs: 500, segs: [{ utf8: 'echo' }] },
        { tStartMs: 1010, dDurationMs: 500, segs: [{ utf8: 'echo' }] },
      ],
    })
    expect(parseJson3(doc).words).toHaveLength(1)
  })

  it('keeps a word genuinely said twice, seconds apart', () => {
    const doc = JSON.stringify({
      events: [
        { tStartMs: 1000, dDurationMs: 500, segs: [{ utf8: 'no' }] },
        { tStartMs: 4000, dDurationMs: 500, segs: [{ utf8: 'no' }] },
      ],
    })
    expect(parseJson3(doc).words).toHaveLength(2)
  })
})

describe('parseJson3 — junk', () => {
  it('returns nothing rather than throwing on unparseable input', () => {
    expect(parseJson3('not json at all')).toEqual({ words: [], wordTimed: false })
  })

  it('survives an events array full of the wrong shapes', () => {
    const doc = JSON.stringify({ events: [null, 3, { segs: 'nope' }, { tStartMs: 'x' }] })
    expect(parseJson3(doc).words).toEqual([])
  })

  it('skips segments that are only whitespace', () => {
    const doc = JSON.stringify({
      events: [{ tStartMs: 0, dDurationMs: 100, segs: [{ utf8: '   ' }] }],
    })
    expect(parseJson3(doc).words).toEqual([])
  })
})

describe('parseJson3 — a real YouTube ASR file', () => {
  const parsed = parseJson3(fixture('youtube-auto.json3'))

  it('finds word-level timing', () => {
    expect(parsed.wordTimed).toBe(true)
  })

  it('reads a plausible number of words', () => {
    expect(parsed.words.length).toBeGreaterThan(50)
  })

  it('produces times that only move forwards', () => {
    for (let i = 1; i < parsed.words.length; i++) {
      expect(parsed.words[i].t).toBeGreaterThanOrEqual(parsed.words[i - 1].t)
    }
  })

  it('gives every word a non-zero duration', () => {
    expect(parsed.words.every((w) => w.d > 0)).toBe(true)
  })

  it('never emits an empty or padded word', () => {
    expect(parsed.words.every((w) => w.text === w.text.trim() && w.text.length > 0)).toBe(
      true,
    )
  })

  it('reads back as the sentence that was actually said', () => {
    const text = parsed.words.map((w) => w.text).join(' ')
    expect(text).toContain("I'm Helen Wolters")
  })
})

describe('spreadWords', () => {
  it('returns nothing for an empty line', () => {
    expect(spreadWords('   ', 0, 5)).toEqual([])
  })

  it('uses the whole duration it was given', () => {
    const words = spreadWords('one two three', 10, 3)
    const last = words[words.length - 1]
    expect(last.t + last.d).toBeCloseTo(13, 5)
  })

  it('gives a word made only of punctuation a floor weight', () => {
    const words = spreadWords('-- hello', 0, 2)
    expect(words).toHaveLength(2)
    expect(words[0].d).toBeGreaterThan(0)
  })
})

describe('parseVtt', () => {
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
Hello <c>there</c>

00:00:04.500 --> 00:00:06.000
second line
`

  it('reads cues into words', () => {
    expect(parseVtt(vtt).map((w) => w.text)).toEqual([
      'Hello',
      'there',
      'second',
      'line',
    ])
  })

  it('starts the first word at the cue time', () => {
    expect(parseVtt(vtt)[0].t).toBe(1)
  })

  it('strips inline markup rather than rendering it', () => {
    expect(parseVtt(vtt).some((w) => w.text.includes('<'))).toBe(false)
  })

  it('reads mm:ss.mmm stamps as well as hh:mm:ss.mmm', () => {
    const short = `WEBVTT

01:30.000 --> 01:32.000
late
`
    expect(parseVtt(short)[0].t).toBe(90)
  })

  it('returns nothing for a file with no cues', () => {
    expect(parseVtt('WEBVTT\n\n')).toEqual([])
  })
})

describe('toTranscript', () => {
  it('reports "none" when there were no words, whatever the source claimed', () => {
    expect(toTranscript('youtube-auto', 'en', [], true).source).toBe('none')
  })

  it('cannot be word-timed with no words', () => {
    expect(toTranscript('youtube-auto', 'en', [], true).wordTimed).toBe(false)
  })

  it('keeps the source when there are words', () => {
    const t = toTranscript('whisper', 'en', [{ t: 0, d: 1, text: 'hi' }], true)
    expect(t.source).toBe('whisper')
    expect(t.wordTimed).toBe(true)
  })
})
