import { describe, expect, it } from 'vitest'
import {
  fitDuration,
  matchQuote,
  mergeOverlapping,
  normalizeDimensions,
  parseClipsResponse,
  resolveRange,
  toCandidates,
  type RawClip,
} from '@/lib/select'
import type { Segment } from '@/lib/types'

const segments: Segment[] = [
  'the opening remarks and thank yous',
  'here is the claim that changes everything',
  'and the reason it matters is money',
  'which nobody wants to talk about openly',
  'so the whole industry pretends otherwise',
  'that is the end of the point being made.',
].map((text, i) => ({ start: i * 10, end: i * 10 + 9, text, words: [] }))

const raw = (over: Partial<RawClip> = {}): RawClip => ({
  startId: 1,
  endId: 3,
  title: 'A clip',
  hook: 'a hook',
  reason: 'because',
  startQuote: '',
  endQuote: '',
  dimensions: normalizeDimensions({}),
  ...over,
})

describe('normalizeDimensions', () => {
  it('reads the six axes', () => {
    const d = normalizeDimensions({
      hook: 9,
      emotion: 8,
      clarity: 7,
      payoff: 6,
      quotability: 5,
      novelty: 4,
    })
    expect(d).toEqual({
      hook: 9,
      emotion: 8,
      clarity: 7,
      payoff: 6,
      quotability: 5,
      novelty: 4,
    })
  })

  it('fills a missing axis with the middle rather than dropping the clip', () => {
    expect(normalizeDimensions({ hook: 9 }).emotion).toBe(5)
  })

  it('treats a non-numeric answer as the middle', () => {
    expect(normalizeDimensions({ hook: 'very high' }).hook).toBe(5)
  })

  it('clamps a model that scores out of ten out of a hundred', () => {
    expect(normalizeDimensions({ hook: 95 }).hook).toBe(10)
  })

  it('clamps a negative score to zero', () => {
    expect(normalizeDimensions({ hook: -4 }).hook).toBe(0)
  })

  it('survives being handed nothing at all', () => {
    expect(normalizeDimensions(undefined).clarity).toBe(5)
  })
})

describe('parseClipsResponse', () => {
  it('reads the documented shape', () => {
    const clips = parseClipsResponse('{"clips":[{"startId":2,"endId":5,"title":"Yes"}]}')
    expect(clips).toHaveLength(1)
    expect(clips[0].startId).toBe(2)
    expect(clips[0].title).toBe('Yes')
  })

  it('reads a bare array', () => {
    expect(parseClipsResponse('[{"startId":1,"endId":2}]')).toHaveLength(1)
  })

  it('reads a single object', () => {
    expect(parseClipsResponse('{"startId":1,"endId":2,"title":"One"}')).toHaveLength(1)
  })

  it('accepts snake_case, which small models produce anyway', () => {
    const [clip] = parseClipsResponse('[{"start_id":4,"end_id":9,"start_quote":"go"}]')
    expect(clip.startId).toBe(4)
    expect(clip.endId).toBe(9)
    expect(clip.startQuote).toBe('go')
  })

  it('digs the JSON out of surrounding prose', () => {
    const answer = 'Sure! Here you go:\n```json\n{"clips":[{"startId":1,"endId":2}]}\n```\nHope that helps.'
    expect(parseClipsResponse(answer)).toHaveLength(1)
  })

  it('names an untitled clip rather than leaving a blank card', () => {
    expect(parseClipsResponse('[{"startId":1,"endId":2}]')[0].title).toBe('Untitled clip')
  })

  it('reads scores from either key the model might use', () => {
    const [a] = parseClipsResponse('[{"startId":1,"endId":2,"scores":{"hook":9}}]')
    const [b] = parseClipsResponse('[{"startId":1,"endId":2,"dimensions":{"hook":9}}]')
    expect(a.dimensions.hook).toBe(9)
    expect(b.dimensions.hook).toBe(9)
  })

  it('throws when there is no JSON at all, rather than returning nothing', () => {
    expect(() => parseClipsResponse('I could not find any good clips.')).toThrow()
  })
})

describe('matchQuote', () => {
  it('finds the segment a quote came from', () => {
    expect(matchQuote('the claim that changes everything', segments)).toBe(1)
  })

  it('tolerates a paraphrase that keeps most of the words', () => {
    expect(matchQuote('here is the claim that changes', segments)).toBe(1)
  })

  it('ignores punctuation and case', () => {
    expect(matchQuote('THE CLAIM, THAT CHANGES EVERYTHING!', segments)).toBe(1)
  })

  it('refuses to place a quote the model invented', () => {
    expect(matchQuote('quantum tunnelling in llamas', segments)).toBe(-1)
  })

  it('refuses an empty quote', () => {
    expect(matchQuote('   ', segments)).toBe(-1)
  })
})

describe('resolveRange', () => {
  it('prefers ids, which the model copied rather than guessed', () => {
    expect(resolveRange(raw({ startId: 2, endId: 4 }), segments)).toEqual({
      startSeg: 2,
      endSeg: 4,
    })
  })

  it('falls back to quotes when the ids are nonsense', () => {
    const range = resolveRange(
      raw({
        startId: NaN,
        endId: 999,
        startQuote: 'the claim that changes everything',
        endQuote: 'the whole industry pretends otherwise',
      }),
      segments,
    )
    expect(range).toEqual({ startSeg: 1, endSeg: 4 })
  })

  it('gives a default length when only one end resolves', () => {
    const range = resolveRange(raw({ startId: 1, endId: -5 }), segments)
    expect(range?.startSeg).toBe(1)
    expect(range?.endSeg).toBe(segments.length - 1)
  })

  it('discards a candidate it cannot place at all', () => {
    expect(resolveRange(raw({ startId: NaN, endId: NaN }), segments)).toBeNull()
  })

  it('swaps ends the model put the wrong way round', () => {
    expect(resolveRange(raw({ startId: 4, endId: 1 }), segments)).toEqual({
      startSeg: 1,
      endSeg: 4,
    })
  })
})

describe('fitDuration', () => {
  it('leaves a span that already fits alone', () => {
    expect(fitDuration(1, 3, segments, 20, 60)).toEqual({ startSeg: 1, endSeg: 3 })
  })

  it('grows a span that is too short', () => {
    const fitted = fitDuration(1, 1, segments, 30, 60)
    expect(segments[fitted.endSeg].end - segments[fitted.startSeg].start).toBeGreaterThanOrEqual(30)
  })

  it('grows forwards first, so the opening line survives', () => {
    expect(fitDuration(2, 2, segments, 25, 90).startSeg).toBe(2)
  })

  it('shrinks a span that is too long', () => {
    const fitted = fitDuration(0, 5, segments, 5, 25)
    expect(segments[fitted.endSeg].end - segments[fitted.startSeg].start).toBeLessThanOrEqual(25)
  })

  it('never shrinks below a single segment', () => {
    const fitted = fitDuration(2, 4, segments, 1, 0.5)
    expect(fitted.endSeg).toBe(fitted.startSeg)
  })

  it('stops growing when it runs out of transcript', () => {
    const fitted = fitDuration(0, 5, segments, 10_000, 20_000)
    expect(fitted).toEqual({ startSeg: 0, endSeg: 5 })
  })
})

describe('mergeOverlapping', () => {
  it('keeps clips that do not touch', () => {
    const clips = [
      { start: 0, end: 30, score: 60 },
      { start: 40, end: 70, score: 50 },
    ]
    expect(mergeOverlapping(clips)).toHaveLength(2)
  })

  it('drops the weaker of two clips covering the same moment', () => {
    const clips = [
      { start: 0, end: 60, score: 55 },
      { start: 10, end: 50, score: 80 },
    ]
    const kept = mergeOverlapping(clips)
    expect(kept).toHaveLength(1)
    expect(kept[0].score).toBe(80)
  })

  it('measures overlap against the shorter clip, not the longer', () => {
    // 5s of overlap is trivial for the 100s clip and total for the 5s one.
    const clips = [
      { start: 0, end: 100, score: 50 },
      { start: 95, end: 100, score: 90 },
    ]
    expect(mergeOverlapping(clips)).toHaveLength(1)
  })

  it('keeps a brief graze between two long clips', () => {
    const clips = [
      { start: 0, end: 60, score: 70 },
      { start: 58, end: 120, score: 70 },
    ]
    expect(mergeOverlapping(clips)).toHaveLength(2)
  })

  it('returns what survives in transcript order, not score order', () => {
    const clips = [
      { start: 100, end: 130, score: 90 },
      { start: 0, end: 30, score: 50 },
    ]
    expect(mergeOverlapping(clips).map((c) => c.start)).toEqual([0, 100])
  })

  it('handles an empty list', () => {
    expect(mergeOverlapping([])).toEqual([])
  })
})

describe('toCandidates', () => {
  it('places a well-formed answer', () => {
    const [candidate] = toCandidates([raw({ startId: 1, endId: 3 })], segments, 20, 60)
    expect(candidate.start).toBe(10)
    expect(candidate.end).toBe(39)
  })

  it('drops what it cannot place instead of failing the batch', () => {
    const candidates = toCandidates(
      [raw({ startId: NaN, endId: NaN }), raw({ startId: 1, endId: 3 })],
      segments,
      20,
      60,
    )
    expect(candidates).toHaveLength(1)
  })

  it('drops a range too short to be a clip at all', () => {
    const tiny: Segment[] = [{ start: 0, end: 2, text: 'blink', words: [] }]
    expect(toCandidates([raw({ startId: 0, endId: 0 })], tiny, 20, 60)).toEqual([])
  })

  it('carries the model\'s words through unchanged', () => {
    const [candidate] = toCandidates(
      [raw({ title: 'The money line', hook: 'nobody says this' })],
      segments,
      20,
      60,
    )
    expect(candidate.title).toBe('The money line')
    expect(candidate.hook).toBe('nobody says this')
  })
})
