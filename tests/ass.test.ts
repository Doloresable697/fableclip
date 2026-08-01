import { describe, expect, it } from 'vitest'
import {
  assTime,
  balance,
  bgrColor,
  buildAss,
  escapeAss,
  isSpecific,
  PRESETS,
  presetFor,
  toLines,
} from '@/lib/ass'
import type { Word } from '@/lib/types'

const preset = PRESETS.punch

function say(text: string, start = 0, each = 0.4, gap = 0): Word[] {
  let t = start
  return text.split(' ').map((word) => {
    const w = { t, d: each, text: word }
    t += each + gap
    return w
  })
}

describe('bgrColor', () => {
  it('reverses the byte order, because ASS is BGR not RGB', () => {
    expect(bgrColor('#FF0000')).toBe('&H000000FF')
    expect(bgrColor('#0000FF')).toBe('&H00FF0000')
  })

  it('leaves a grey unchanged, which is why the order must be tested on a red', () => {
    expect(bgrColor('#FFFFFF')).toBe('&H00FFFFFF')
  })

  it('writes the alpha first', () => {
    expect(bgrColor('#000000', 128)).toBe('&H80000000')
  })

  it('expands three-digit hex', () => {
    expect(bgrColor('#F00')).toBe('&H000000FF')
  })

  it('accepts a value with no leading hash', () => {
    expect(bgrColor('FFE04D')).toBe('&H004DE0FF')
  })

  it('clamps an out-of-range alpha instead of producing bad hex', () => {
    expect(bgrColor('#000000', 999)).toBe('&HFF000000')
  })
})

describe('assTime', () => {
  it('writes h:mm:ss.cc', () => {
    expect(assTime(0)).toBe('0:00:00.00')
    expect(assTime(3661.5)).toBe('1:01:01.50')
  })

  it('keeps centiseconds, which is all the format has', () => {
    expect(assTime(1.239)).toBe('0:00:01.23')
  })

  it('never writes a negative time', () => {
    expect(assTime(-5)).toBe('0:00:00.00')
  })
})

describe('escapeAss', () => {
  it('neutralises the brace that opens an override block', () => {
    expect(escapeAss('a {b} c')).not.toContain('{')
    expect(escapeAss('a {b} c')).not.toContain('}')
  })

  it('neutralises a backslash, which would eat the next character', () => {
    expect(escapeAss('back\\slash')).not.toContain('\\s')
  })

  it('turns a newline into the ASS line break', () => {
    expect(escapeAss('one\ntwo')).toBe('one\\Ntwo')
  })

  it('strips control characters that have no glyph', () => {
    expect(escapeAss('ab')).toBe('ab')
  })

  it('leaves ordinary text alone', () => {
    expect(escapeAss("It's a test — really")).toBe("It's a test — really")
  })
})

describe('toLines', () => {
  it('breaks when the line is full by word count', () => {
    const lines = toLines(say('one two three four five six seven eight'), {
      ...preset,
      wordsPerLine: 3,
      maxChars: 999,
    })
    expect(lines.every((l) => l.words.length <= 3)).toBe(true)
  })

  it('breaks when the line is full by width', () => {
    const lines = toLines(say('alpha bravo charlie delta'), {
      ...preset,
      wordsPerLine: 99,
      maxChars: 12,
    })
    expect(lines.length).toBeGreaterThan(1)
  })

  it('breaks at the end of a sentence', () => {
    const lines = toLines(say('stop here. now go'), { ...preset, wordsPerLine: 99, maxChars: 999 })
    expect(lines).toHaveLength(2)
    expect(lines[0].words.map((w) => w.text).join(' ')).toBe('stop here.')
  })

  it('breaks on a pause, so a line does not hang through silence', () => {
    const words = [...say('before the pause', 0), ...say('after it', 12)]
    const lines = toLines(words, { ...preset, wordsPerLine: 99, maxChars: 999 })
    expect(lines).toHaveLength(2)
  })

  it('ends a line at its last word, not at the next one', () => {
    const words = [...say('one two', 0, 0.5), ...say('three', 20, 0.5)]
    const [first] = toLines(words, preset)
    expect(first.end).toBeLessThan(20)
  })

  it('gives even a single instant word some time on screen', () => {
    const [line] = toLines([{ t: 5, d: 0, text: 'flash' }], preset)
    expect(line.end).toBeGreaterThan(line.start)
  })

  it('skips blank words rather than emitting an empty caption', () => {
    const lines = toLines([{ t: 0, d: 1, text: '  ' }], preset)
    expect(lines).toEqual([])
  })

  it('returns nothing for no words', () => {
    expect(toLines([], preset)).toEqual([])
  })
})

describe('caption polish', () => {
  it('drops filler from the captions', () => {
    // The audio still says it; the screen should not. A real clip read
    // "A SECURITY UH MECHANISM".
    const lines = toLines(say('a security uh mechanism', 0, 0.4), preset)
    const shown = lines.flatMap((l) => l.words.map((w) => w.text))
    expect(shown).toEqual(['a', 'security', 'mechanism'])
  })

  it('drops filler however it was transcribed', () => {
    const lines = toLines(say('so um, uhh well erm yes', 0, 0.4), preset)
    const shown = lines.flatMap((l) => l.words.map((w) => w.text))
    expect(shown).toEqual(['so', 'well', 'yes'])
  })

  it('does not mistake a real word for filler', () => {
    const lines = toLines(say('a humble umbrella', 0, 0.4), preset)
    const shown = lines.flatMap((l) => l.words.map((w) => w.text))
    expect(shown).toEqual(['a', 'humble', 'umbrella'])
  })

  it('never strands one word alone on the last line', () => {
    const lines = toLines(say('the whole thing fell apart', 0, 0.4), {
      ...preset,
      wordsPerLine: 4,
      maxChars: 99,
    })
    expect(lines[lines.length - 1].words.length).toBeGreaterThan(1)
  })

  it('does not rob a line that is already short', () => {
    const lines = balance(
      [
        { words: say('one two', 0, 0.4), start: 0, end: 0.8 },
        { words: say('three', 1, 0.4), start: 1, end: 1.4 },
      ],
      preset,
    )
    expect(lines[0].words).toHaveLength(2)
  })

  it('leaves the orphan alone when moving a word would overflow', () => {
    const narrow = { ...preset, maxChars: 8 }
    const lines = balance(
      [
        { words: say('alpha bravo charlie', 0, 0.4), start: 0, end: 1.2 },
        { words: say('delta', 2, 0.4), start: 2, end: 2.4 },
      ],
      narrow,
    )
    expect(lines[1].words).toHaveLength(1)
  })

  it('keeps the line timings honest after moving a word', () => {
    const lines = toLines(say('the whole thing fell apart', 0, 0.4), {
      ...preset,
      wordsPerLine: 4,
      maxChars: 99,
    })
    for (const line of lines) {
      expect(line.start).toBeCloseTo(line.words[0].t, 3)
      expect(line.end).toBeGreaterThan(line.start)
    }
  })
})

describe('isSpecific', () => {
  it('spots a number', () => {
    expect(isSpecific('600')).toBe(true)
    expect(isSpecific('$600')).toBe(true)
    expect(isSpecific('90%')).toBe(true)
    expect(isSpecific('2029.')).toBe(true)
  })

  it('leaves ordinary words alone', () => {
    expect(isSpecific('saffron')).toBe(false)
    expect(isSpecific('')).toBe(false)
  })
})

describe('buildAss', () => {
  const ass = buildAss(say('hello there world again', 0, 0.5), {
    width: 1080,
    height: 1920,
    preset,
  })

  it('writes the three sections libass expects', () => {
    expect(ass).toContain('[Script Info]')
    expect(ass).toContain('[V4+ Styles]')
    expect(ass).toContain('[Events]')
  })

  it('declares the resolution it was rendered for', () => {
    expect(ass).toContain('PlayResX: 1080')
    expect(ass).toContain('PlayResY: 1920')
  })

  it('names the bundled font, not a system one', () => {
    expect(ass).toContain('Style: Caption,Anton,')
  })

  it('emits one event per word, not one per line', () => {
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
    expect(events).toHaveLength(4)
  })

  it('colours exactly one word per event', () => {
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
    for (const event of events) {
      expect(event.match(/\{\\c&H/g) ?? []).toHaveLength(1)
    }
  })

  it('moves the highlight through the line word by word', () => {
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
    const highlighted = events.map((e) => e.match(/\{\\c&H[0-9A-F]+\}([A-Z]+)\{/)?.[1])
    expect(highlighted).toEqual(['HELLO', 'THERE', 'WORLD', 'AGAIN'])
  })

  it('shows the whole line in every event, not just the active word', () => {
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
    expect(events[0]).toContain('AGAIN')
  })

  it('holds each word until the next begins, leaving no gaps', () => {
    const times = ass
      .split('\n')
      .filter((l) => l.startsWith('Dialogue:'))
      .map((l) => l.split(',').slice(1, 3))

    for (let i = 1; i < times.length; i++) {
      expect(times[i][0]).toBe(times[i - 1][1])
    }
  })

  it('uppercases for a preset that asks for it', () => {
    expect(ass).toContain('HELLO')
    expect(ass).not.toContain('hello')
  })

  it('leaves case alone for a preset that does not', () => {
    const clean = buildAss(say('Hello there'), {
      width: 1080,
      height: 1920,
      preset: PRESETS.clean,
    })
    expect(clean).toContain('Hello')
  })

  it('scales the caption down for a 16:9 render', () => {
    const wide = buildAss(say('hi there'), { width: 1920, height: 1080, preset })
    const tallSize = Number(ass.match(/Style: Caption,Anton,(\d+)/)?.[1])
    const wideSize = Number(wide.match(/Style: Caption,Anton,(\d+)/)?.[1])
    expect(wideSize).toBeLessThan(tallSize)
  })

  it('escapes transcript text that would be read as markup', () => {
    const risky = buildAss([{ t: 0, d: 1, text: '{drop}' }], {
      width: 1080,
      height: 1920,
      preset,
    })
    const [event] = risky.split('\n').filter((l) => l.startsWith('Dialogue:'))
    // The only braces left are the override tags this file wrote itself.
    expect(event.replace(/\{\\[^}]*\}/g, '')).not.toContain('{')
  })

  it('holds a number in its own accent while another word is spoken', () => {
    const withNumber = buildAss(say('costs 600 dollars each', 0, 0.4), {
      width: 1080,
      height: 1920,
      preset,
    })
    const [first] = withNumber.split('\n').filter((l) => l.startsWith('Dialogue:'))
    // Two coloured words on the first event: the active one, and the number.
    expect(first.match(/\{\\c&H/g) ?? []).toHaveLength(2)
  })

  it('lets the spoken word win the colour when it is the number', () => {
    const withNumber = buildAss(say('costs 600 dollars each', 0, 0.4), {
      width: 1080,
      height: 1920,
      preset,
    })
    const events = withNumber.split('\n').filter((l) => l.startsWith('Dialogue:'))
    // On the event where "600" is active, it must carry the active colour.
    const active = events[1].match(/\{\\c(&H[0-9A-F]+)\}600/)?.[1]
    expect(active).toBe(bgrColor(preset.active))
  })

  it('produces a valid file with no words at all', () => {
    const empty = buildAss([], { width: 1080, height: 1920, preset })
    expect(empty).toContain('[Events]')
    expect(empty.split('\n').filter((l) => l.startsWith('Dialogue:'))).toHaveLength(0)
  })

  it('ends with a newline, which some parsers require', () => {
    expect(ass.endsWith('\n')).toBe(true)
  })
})

describe('presetFor', () => {
  it('returns nothing for "none", meaning do not burn captions', () => {
    expect(presetFor('none')).toBeNull()
  })

  it('returns a preset for every other style', () => {
    for (const style of ['punch', 'clean', 'chunky', 'condensed'] as const) {
      expect(presetFor(style)).not.toBeNull()
    }
  })
})
