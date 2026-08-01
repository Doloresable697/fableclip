import { describe, expect, it } from 'vitest'
import { sanitize, slugify } from '@/lib/http'
import { lastMeaningfulLine } from '@/lib/bin'
import { normalizeOptions } from '@/lib/options'
import { DEFAULT_OPTIONS } from '@/lib/types'

describe('sanitize', () => {
  it('leaves an ordinary filename alone', () => {
    expect(sanitize('my clip.mp4')).toBe('my clip.mp4')
  })

  it('removes the quote that would break out of the header', () => {
    expect(sanitize('evil".mp4')).not.toContain('"')
  })

  it('removes path separators', () => {
    expect(sanitize('../../etc/passwd')).not.toContain('/')
  })

  it('removes a newline, which would inject a second header', () => {
    expect(sanitize('a\r\nContent-Length: 0')).not.toMatch(/[\r\n]/)
  })

  it('never returns an empty name', () => {
    expect(sanitize('///')).toBe('clip')
  })

  it('caps the length', () => {
    expect(sanitize('x'.repeat(500)).length).toBeLessThanOrEqual(120)
  })
})

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('The Money Line')).toBe('the-money-line')
  })

  it('drops punctuation', () => {
    expect(slugify("Here's why — really!")).toBe('here-s-why-really')
  })

  it('does not start or end with a hyphen', () => {
    expect(slugify('  !hello!  ')).toBe('hello')
  })

  it('falls back when there is nothing left', () => {
    expect(slugify('!!!')).toBe('clip')
  })

  it('keeps letters from other alphabets rather than deleting the whole title', () => {
    expect(slugify('привет мир')).toBe('привет-мир')
  })
})

describe('normalizeOptions', () => {
  it('uses the defaults for an empty body', () => {
    expect(normalizeOptions({})).toEqual(DEFAULT_OPTIONS)
  })

  it('accepts sensible values', () => {
    const options = normalizeOptions({ clipCount: 10, minSeconds: 30, maxSeconds: 90 })
    expect(options).toMatchObject({ clipCount: 10, minSeconds: 30, maxSeconds: 90 })
  })

  it('clamps a clip count nobody wants to wait for', () => {
    expect(normalizeOptions({ clipCount: 5000 }).clipCount).toBe(20)
  })

  it('clamps a clip count of zero', () => {
    expect(normalizeOptions({ clipCount: 0 }).clipCount).toBe(1)
  })

  it('keeps max above min however they were sent', () => {
    const options = normalizeOptions({ minSeconds: 90, maxSeconds: 10 })
    expect(options.maxSeconds).toBeGreaterThan(options.minSeconds)
  })

  it('refuses an unknown reframe mode', () => {
    expect(normalizeOptions({ reframe: 'rm -rf' }).reframe).toBe(DEFAULT_OPTIONS.reframe)
  })

  it('refuses an unknown caption style', () => {
    expect(normalizeOptions({ captionStyle: 'comic sans' }).captionStyle).toBe(
      DEFAULT_OPTIONS.captionStyle,
    )
  })

  it('accepts a real language tag', () => {
    expect(normalizeOptions({ lang: 'pt-BR' }).lang).toBe('pt-BR')
  })

  it('refuses something that is not a language tag', () => {
    expect(normalizeOptions({ lang: '../../etc' }).lang).toBe(DEFAULT_OPTIONS.lang)
  })

  it('refuses a whisper model that is not one of the sizes', () => {
    expect(normalizeOptions({ whisperModel: 'enormous' }).whisperModel).toBe(
      DEFAULT_OPTIONS.whisperModel,
    )
  })

  it('survives being handed nothing', () => {
    expect(normalizeOptions(undefined)).toEqual(DEFAULT_OPTIONS)
  })

  it('survives being handed a string', () => {
    expect(normalizeOptions('nope')).toEqual(DEFAULT_OPTIONS)
  })
})

describe('lastMeaningfulLine', () => {
  it('picks the error out of ffmpeg\'s preamble', () => {
    const stderr = [
      'ffmpeg version 7.1 Copyright (c) 2000-2024',
      '  configuration: --enable-gpl --enable-libass',
      '  libavutil      59. 39.100',
      'source.mp4: No such file or directory',
    ].join('\n')

    expect(lastMeaningfulLine(stderr)).toBe('source.mp4: No such file or directory')
  })

  it('ignores progress noise', () => {
    const stderr = 'frame=  120 fps=30\nsize=    1024kB\nError opening filters!'
    expect(lastMeaningfulLine(stderr)).toBe('Error opening filters!')
  })

  it('ignores yt-dlp download lines', () => {
    const stderr = '[download] 100% of 4MiB\nERROR: Video unavailable'
    expect(lastMeaningfulLine(stderr)).toBe('ERROR: Video unavailable')
  })

  it('falls back to the last line when nothing looks like an error', () => {
    expect(lastMeaningfulLine('one\ntwo\nthree')).toBe('three')
  })

  it('says so rather than returning an empty string', () => {
    expect(lastMeaningfulLine('')).toBe('no output')
  })

  it('caps the length, so a wall of output is not the error message', () => {
    expect(lastMeaningfulLine(`Error: ${'x'.repeat(2000)}`).length).toBeLessThanOrEqual(400)
  })
})
