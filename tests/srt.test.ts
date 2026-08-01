import { describe, expect, it } from 'vitest'
import { buildSrt, srtTime } from '@/lib/srt'
import type { Word } from '@/lib/types'

function say(text: string, start = 0, each = 0.4, gap = 0): Word[] {
  let t = start
  return text.split(' ').map((word) => {
    const w = { t, d: each, text: word }
    t += each + gap
    return w
  })
}

describe('srtTime', () => {
  it('writes hh:mm:ss,mmm with a comma', () => {
    expect(srtTime(0)).toBe('00:00:00,000')
    expect(srtTime(3661.25)).toBe('01:01:01,250')
  })

  it('pads every field', () => {
    expect(srtTime(5.007)).toBe('00:00:05,007')
  })

  it('never writes a negative time', () => {
    expect(srtTime(-1)).toBe('00:00:00,000')
  })

  it('does not roll over to 1000 milliseconds', () => {
    expect(srtTime(1.9999)).toBe('00:00:01,999')
  })
})

describe('buildSrt', () => {
  it('numbers cues from one', () => {
    expect(buildSrt(say('hello there')).startsWith('1\n')).toBe(true)
  })

  it('writes the arrow between the two stamps', () => {
    expect(buildSrt(say('hello there'))).toContain(' --> ')
  })

  it('groups into readable lines, not two words at a time', () => {
    // The burned-in captions run three or four words wide because that is
    // what reads on a phone. A .srt built the same way would be hundreds of
    // two-word cues, which no editor and no upload flow wants.
    const srt = buildSrt(say('one two three four five six seven eight nine ten eleven twelve'))
    const cues = srt.split('\n\n').filter(Boolean)

    expect(cues.length).toBeLessThanOrEqual(2)
    for (const cue of cues) {
      const text = cue.split('\n')[2] ?? ''
      expect(text.split(' ').length).toBeGreaterThan(3)
    }
  })

  it('breaks at the end of a sentence', () => {
    const srt = buildSrt(say('that is all. now this part'))
    expect(srt).toContain('2\n')
  })

  it('breaks on a long pause', () => {
    const srt = buildSrt([...say('before', 0), ...say('after', 30)])
    expect(srt).toContain('2\n')
  })

  it('gives every cue a visible duration', () => {
    const srt = buildSrt([{ t: 0, d: 0, text: 'flash' }])
    const [, times] = srt.split('\n')
    const [from, to] = times.split(' --> ')
    expect(to).not.toBe(from)
  })

  it('skips blank words', () => {
    expect(buildSrt([{ t: 0, d: 1, text: '   ' }])).toBe('')
  })

  it('returns an empty file for no words', () => {
    expect(buildSrt([])).toBe('')
  })

  it('emits cues in order', () => {
    const srt = buildSrt(say('a b. c d. e f.'))
    const numbers = [...srt.matchAll(/^(\d+)$/gm)].map((m) => Number(m[1]))
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b))
  })
})
