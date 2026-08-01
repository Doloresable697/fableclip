import { describe, expect, it } from 'vitest'
import { parseWhisperLine, whisperArgs, whisperOptions, WHISPER_SCRIPT } from '@/lib/whisper'

describe('parseWhisperLine', () => {
  it('reads the opening info line', () => {
    expect(parseWhisperLine('{"event":"info","lang":"en","duration":120.5}')).toEqual({
      event: 'info',
      lang: 'en',
      duration: 120.5,
    })
  })

  it('reads a segment with its words', () => {
    const event = parseWhisperLine(
      '{"event":"segment","end":4.2,"words":[{"t":1,"d":0.5,"text":" hello "}]}',
    )
    expect(event).toEqual({
      event: 'segment',
      end: 4.2,
      words: [{ t: 1, d: 0.5, text: 'hello' }],
    })
  })

  it('reads the done line', () => {
    expect(parseWhisperLine('{"event":"done"}')).toEqual({ event: 'done' })
  })

  it('ignores a line that is not JSON — Python warns on stderr', () => {
    expect(parseWhisperLine('UserWarning: ctranslate2 something')).toBeNull()
  })

  it('ignores JSON that is not one of the events', () => {
    expect(parseWhisperLine('{"event":"unknown"}')).toBeNull()
  })

  it('ignores truncated JSON rather than throwing mid-stream', () => {
    expect(parseWhisperLine('{"event":"segm')).toBeNull()
  })

  it('drops words with no text', () => {
    const event = parseWhisperLine(
      '{"event":"segment","end":1,"words":[{"t":0,"d":1,"text":"  "},{"t":1,"d":1,"text":"ok"}]}',
    )
    expect(event).toEqual({ event: 'segment', end: 1, words: [{ t: 1, d: 1, text: 'ok' }] })
  })

  it('drops words missing a timing', () => {
    const event = parseWhisperLine('{"event":"segment","end":1,"words":[{"text":"ok"}]}')
    expect(event).toEqual({ event: 'segment', end: 1, words: [] })
  })

  it('gives a zero-length word a floor, so it can still be shown', () => {
    const event = parseWhisperLine(
      '{"event":"segment","end":1,"words":[{"t":0,"d":0,"text":"a"}]}',
    )
    expect(event).toMatchObject({ words: [{ d: 0.05 }] })
  })

  it('survives a segment with no words array at all', () => {
    expect(parseWhisperLine('{"event":"segment","end":9}')).toEqual({
      event: 'segment',
      end: 9,
      words: [],
    })
  })
})

describe('whisperOptions', () => {
  it('uses the model it was given', () => {
    expect(whisperOptions('small', 'en').model).toBe('small')
  })

  it('turns "auto" into an empty language, which means detect', () => {
    expect(whisperOptions('base', 'auto').lang).toBe('')
  })

  it('defaults to int8 on a CPU', () => {
    expect(whisperOptions('base', 'en').compute).toBe('int8')
    expect(whisperOptions('base', 'en').device).toBe('cpu')
  })
})

describe('whisperArgs', () => {
  const args = whisperArgs('/tmp/audio.wav', whisperOptions('base', 'en'))

  it('runs the script inline rather than from a file', () => {
    expect(args[0]).toBe('-c')
  })

  it('passes the five arguments the script reads, in order', () => {
    expect(args.slice(2)).toEqual(['/tmp/audio.wav', 'base', 'cpu', 'int8', 'en'])
  })

  it('always passes the language slot, even when empty', () => {
    expect(whisperArgs('/a.wav', whisperOptions('base', 'auto'))).toHaveLength(7)
  })
})

describe('WHISPER_SCRIPT', () => {
  it('asks for word timestamps, which is the entire reason it exists', () => {
    expect(WHISPER_SCRIPT).toContain('word_timestamps=True')
  })

  it('exits with a distinct code when the library is missing', () => {
    expect(WHISPER_SCRIPT).toContain('SystemExit(3)')
  })

  it('flushes each line, so progress arrives while it runs', () => {
    expect(WHISPER_SCRIPT).toContain('flush=True')
  })
})
