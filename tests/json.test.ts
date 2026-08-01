import { describe, it, expect } from 'vitest'
import { extractJson } from '@/lib/json'

describe('extractJson', () => {
  it('parses bare JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('parses JSON inside a fenced block', () => {
    const text = 'Here you go:\n```json\n{"a":1}\n```\nHope that helps!'
    expect(extractJson(text)).toEqual({ a: 1 })
  })

  it('parses a fenced block with no language tag', () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('ignores prose before and after unfenced JSON', () => {
    expect(extractJson('Sure! {"a":1} Let me know.')).toEqual({ a: 1 })
  })

  it('handles braces inside strings', () => {
    expect(extractJson('{"a":"}{"}')).toEqual({ a: '}{' })
  })

  it('handles escaped quotes inside strings', () => {
    expect(extractJson('{"a":"say \\"hi\\""}')).toEqual({ a: 'say "hi"' })
  })

  it('parses nested objects to the correct closing brace', () => {
    expect(extractJson('{"a":{"b":2}} trailing')).toEqual({ a: { b: 2 } })
  })

  it('parses top-level arrays', () => {
    expect(extractJson('[1,2,3]')).toEqual([1, 2, 3])
  })

  it('throws a clear error when there is no JSON', () => {
    expect(() => extractJson('I cannot help with that')).toThrow(/No JSON/)
  })

  it('repairs truncated JSON rather than throwing', () => {
    // This used to be an error. Closing what the model left open recovers a
    // correct answer far more often than it invents a wrong one.
    expect(extractJson('{"a":{"b":2}')).toEqual({ a: { b: 2 } })
  })

  it('skips a decoy example fence and returns the real answer', () => {
    const text =
      'Example format:\n```\n{"example":true}\n```\nActual answer: {"a":42}'
    expect(extractJson(text)).toEqual({ a: 42 })
  })

  it('finds JSON in a later fence when an earlier fence is not JSON', () => {
    const text = '```bash\necho hi\n```\nThen the json:\n```json\n{"a":1}\n```'
    expect(extractJson(text)).toEqual({ a: 1 })
  })

  it('skips prose braces that balance but do not parse', () => {
    expect(extractJson('Use {curly} braces like this: {"a":1}')).toEqual({ a: 1 })
  })

  it('returns the last complete value when several are present', () => {
    expect(extractJson('{"a":1} then {"b":2}')).toEqual({ b: 2 })
  })

  it('handles an empty fence before the real one', () => {
    expect(extractJson('```\n```\n```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('does not hang on a long run of unmatched openers', () => {
    const started = performance.now()
    expect(() => extractJson('{'.repeat(200_000))).toThrow(/Unterminated/)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

describe('repairing malformed model JSON', () => {
  /**
   * Verbatim from qwen2.5-coder:7b on the outline call: the array closes
   * before the last object does. Every field is correct; one brace is not.
   */
  it('repairs a closer that arrives in the wrong order', () => {
    const broken = `{
  "title": "Replacing Live Chat",
  "slides": [
    { "layout": "title", "brief": "Introduce the topic" },
    { "layout": "closing", "brief": "Conclude"
  ]
}`
    const value = extractJson<{ title: string; slides: unknown[] }>(broken)
    expect(value.title).toBe('Replacing Live Chat')
    expect(value.slides).toHaveLength(2)
  })

  it('closes a response cut off mid-object', () => {
    const value = extractJson<{ a: number; b: { c: number } }>(
      '{"a": 1, "b": {"c": 2',
    )
    expect(value).toEqual({ a: 1, b: { c: 2 } })
  })

  it('closes a response cut off inside a string', () => {
    const value = extractJson<{ title: string }>('{"title": "half a titl')
    expect(value.title).toBe('half a titl')
  })

  it('drops a dangling comma left by truncation', () => {
    expect(extractJson('{"a": 1, "b": 2,')).toEqual({ a: 1, b: 2 })
    expect(extractJson('{"items": [1, 2, 3,')).toEqual({ items: [1, 2, 3] })
  })

  it('does not let a repair beat a value that parsed cleanly', () => {
    // The last clean parse still wins; repair only runs when nothing parsed.
    expect(extractJson('{"first": 1} then {"second": 2}')).toEqual({
      second: 2,
    })
  })

  it('leaves string contents alone, brackets included', () => {
    const value = extractJson<{ note: string }>(
      '{"note": "use {curly} and [square] brackets"',
    )
    expect(value.note).toBe('use {curly} and [square] brackets')
  })

  it('still refuses output with no JSON in it at all', () => {
    expect(() => extractJson('I cannot help with that request.')).toThrow()
  })

  it('still refuses something that cannot be repaired into valid JSON', () => {
    expect(() => extractJson('{this is not json at all, no quotes}')).toThrow()
  })
})
