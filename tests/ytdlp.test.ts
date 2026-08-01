import { describe, expect, it } from 'vitest'
import {
  downloadArgs,
  explainYtdlp,
  infoArgs,
  normalizeUrl,
  parseInfo,
  parseProgress,
  pickTrack,
  type SourceInfo,
} from '@/lib/ytdlp'

const info = (over: Partial<SourceInfo> = {}): SourceInfo => ({
  id: 'abc',
  title: 'A talk',
  duration: 1200,
  autoLangs: [],
  manualLangs: [],
  ...over,
})

describe('normalizeUrl', () => {
  it('accepts an ordinary link', () => {
    expect(normalizeUrl('https://www.youtube.com/watch?v=abc')).toBe(
      'https://www.youtube.com/watch?v=abc',
    )
  })

  it('trims surrounding whitespace from a paste', () => {
    expect(normalizeUrl('  https://youtu.be/abc  ')).toBe('https://youtu.be/abc')
  })

  it('rejects text that is not a URL', () => {
    expect(() => normalizeUrl('find me a good video')).toThrow(/not a URL/)
  })

  it('rejects file://, so "paste a link" cannot read the server disk', () => {
    expect(() => normalizeUrl('file:///etc/passwd')).toThrow(/http and https/)
  })

  it('rejects a scheme yt-dlp should never be handed', () => {
    expect(() => normalizeUrl('javascript:alert(1)')).toThrow()
  })

  it('rejects something that would be read as a command-line flag', () => {
    expect(() => normalizeUrl('--exec rm -rf /')).toThrow()
  })
})

describe('parseInfo', () => {
  it('reads the fields the pipeline needs', () => {
    const parsed = parseInfo(
      JSON.stringify({ id: 'xyz', title: 'Real title', duration: 2295.8 }),
    )
    expect(parsed).toMatchObject({ id: 'xyz', title: 'Real title' })
    expect(parsed.duration).toBeCloseTo(2295.8, 1)
  })

  it('lists the caption languages on offer', () => {
    const parsed = parseInfo(
      JSON.stringify({
        automatic_captions: { en: [], 'en-orig': [] },
        subtitles: { fr: [] },
      }),
    )
    expect(parsed.autoLangs).toEqual(['en', 'en-orig'])
    expect(parsed.manualLangs).toEqual(['fr'])
  })

  it('names an untitled video rather than leaving it blank', () => {
    expect(parseInfo('{}').title).toBe('Untitled')
  })

  it('reports a duration of zero for a live stream that has none', () => {
    expect(parseInfo('{}').duration).toBe(0)
  })

  it('throws a readable error rather than a JSON one', () => {
    expect(() => parseInfo('ERROR: unsupported URL')).toThrow(/not JSON/)
  })
})

describe('pickTrack', () => {
  it('prefers machine captions, which carry word timing', () => {
    expect(pickTrack(info({ autoLangs: ['en'], manualLangs: ['en'] }), 'en')).toEqual({
      lang: 'en',
      kind: 'auto',
    })
  })

  it('prefers the -orig track, which is the language actually spoken', () => {
    expect(pickTrack(info({ autoLangs: ['en', 'en-orig'] }), 'en')?.lang).toBe('en-orig')
  })

  it('falls back to uploaded captions when there is no machine track', () => {
    expect(pickTrack(info({ manualLangs: ['en'] }), 'en')).toEqual({
      lang: 'en',
      kind: 'manual',
    })
  })

  it('takes an original track in another language over nothing', () => {
    expect(pickTrack(info({ autoLangs: ['de-orig'] }), 'en')?.lang).toBe('de-orig')
  })

  it('returns nothing when the video has no captions at all', () => {
    expect(pickTrack(info(), 'en')).toBeNull()
  })
})

describe('infoArgs', () => {
  it('asks for JSON without downloading', () => {
    expect(infoArgs('https://x/y')).toContain('--dump-single-json')
  })

  it('skips the roughly 200 machine translations YouTube lists', () => {
    expect(infoArgs('https://x/y')).toContain('youtube:skip=translated_subs')
  })

  it('puts the URL last, after every flag', () => {
    const args = infoArgs('https://x/y')
    expect(args[args.length - 1]).toBe('https://x/y')
  })
})

describe('downloadArgs', () => {
  const args = downloadArgs('https://x/y', '/tmp/job', { lang: 'en', kind: 'auto' })

  it('asks for a format phones can play', () => {
    expect(args.join(' ')).toContain('avc1')
    expect(args).toContain('mp4')
  })

  it('caps the resolution, because 4K is wasted on a 1080-wide crop', () => {
    expect(args.join(' ')).toContain('height<=1080')
  })

  it('writes into the job directory under a predictable name', () => {
    expect(args).toContain('/tmp/job/source.%(ext)s')
  })

  it('asks for the machine caption track when that is what was chosen', () => {
    expect(args).toContain('--write-auto-subs')
    expect(args).not.toContain('--write-subs')
  })

  it('asks for the uploaded track when that is what was chosen', () => {
    const manual = downloadArgs('https://x/y', '/tmp/job', { lang: 'en', kind: 'manual' })
    expect(manual).toContain('--write-subs')
    expect(manual).not.toContain('--write-auto-subs')
  })

  it('asks for exactly one language — a glob earns an HTTP 429', () => {
    const langs = args[args.indexOf('--sub-langs') + 1]
    expect(langs).toBe('en')
    expect(langs).not.toContain('*')
  })

  it('prefers json3, the only format with word timings', () => {
    expect(args[args.indexOf('--sub-format') + 1]).toMatch(/^json3/)
  })

  it('requests no captions at all when there are none to request', () => {
    const none = downloadArgs('https://x/y', '/tmp/job', null)
    expect(none.join(' ')).not.toContain('--sub-langs')
  })

  it('asks for line-by-line progress rather than carriage returns', () => {
    expect(args).toContain('--newline')
  })

  it('refuses to expand a playlist into a hundred downloads', () => {
    expect(args).toContain('--no-playlist')
  })
})

describe('js runtime', () => {
  it('is left out when this yt-dlp has never heard of the flag', () => {
    expect(infoArgs('https://x/y')).not.toContain('--js-runtimes')
    expect(downloadArgs('https://x/y', '/tmp/j', null)).not.toContain('--js-runtimes')
  })

  it('names the runtime when one is available', () => {
    // The container is built on node:22-slim, so a runtime is already there —
    // yt-dlp only looks for `deno` and has to be told.
    expect(infoArgs('https://x/y', 'node')).toContain('--js-runtimes')
    const args = downloadArgs('https://x/y', '/tmp/j', null, 1080, 'node')
    expect(args[args.indexOf('--js-runtimes') + 1]).toBe('node')
  })
})

describe('explainYtdlp', () => {
  it('says a 403 is usually temporary, because it usually is', () => {
    const message = explainYtdlp('ERROR: unable to download video data: HTTP Error 403: Forbidden')
    expect(message).toMatch(/temporar/i)
    expect(message).not.toContain('unable to download video data')
  })

  it('recognises rate limiting', () => {
    expect(explainYtdlp('HTTP Error 429: Too Many Requests')).toMatch(/rate limit/i)
  })

  it('recognises a private video', () => {
    expect(explainYtdlp('ERROR: [youtube] abc: Private video')).toMatch(/private/i)
  })

  it('recognises a removed video', () => {
    expect(explainYtdlp('ERROR: [youtube] abc: Video unavailable')).toMatch(/unavailable/i)
  })

  it('recognises age restriction, and does not offer to take credentials', () => {
    const message = explainYtdlp('ERROR: Sign in to confirm your age')
    expect(message).toMatch(/age-restricted/i)
    expect(message).toMatch(/does not take your YouTube credentials/i)
  })

  it('recognises a link yt-dlp cannot read', () => {
    expect(explainYtdlp('ERROR: Unsupported URL: https://example.com/x')).toMatch(/does not know/i)
  })

  it('passes an unrecognised failure through rather than swallowing it', () => {
    expect(explainYtdlp('ERROR: something entirely new broke')).toContain('something entirely new broke')
  })

  it('drops the ERROR: prefix, which is not information', () => {
    expect(explainYtdlp('ERROR: nope')).not.toContain('ERROR:')
  })

  it('caps the length rather than printing a wall of output', () => {
    expect(explainYtdlp(`ERROR: ${'x'.repeat(3000)}`).length).toBeLessThan(360)
  })

  it('says something rather than nothing for empty output', () => {
    expect(explainYtdlp('').length).toBeGreaterThan(0)
  })
})

describe('parseProgress', () => {
  it('reads a percentage off a download line', () => {
    expect(parseProgress('[download]  42.3% of 41.20MiB at 2.5MiB/s')).toBeCloseTo(42.3, 5)
  })

  it('reads a whole-number percentage', () => {
    expect(parseProgress('[download] 100% of 41.20MiB')).toBe(100)
  })

  it('ignores everything that is not a download line', () => {
    expect(parseProgress('[youtube] abc: Downloading webpage')).toBeNull()
    expect(parseProgress('[Merger] Merging formats into "source.mp4"')).toBeNull()
  })

  it('never returns a value outside 0–100', () => {
    expect(parseProgress('[download] 999% of x')).toBe(100)
  })
})
