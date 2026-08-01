import { beforeEach, describe, expect, it } from 'vitest'
import { createStore, type Store } from '@/lib/store'
import { DEFAULT_OPTIONS, type Clip } from '@/lib/types'

let store: Store

const clip = (over: Partial<Clip> = {}): Clip => ({
  id: 'clip-1',
  jobId: 'job-1',
  index: 0,
  start: 10,
  end: 40,
  title: 'A clip',
  hook: 'a hook',
  reason: 'because',
  dimensions: { hook: 8, emotion: 7, clarity: 9, payoff: 6, quotability: 5, novelty: 4 },
  score: 72,
  breakdown: { base: 68, modifiers: [{ label: 'well sized', delta: 5, detail: '30s' }], total: 72 },
  words: [{ t: 0, d: 0.4, text: 'hello' }],
  reframe: 'crop',
  focus: 0,
  captionStyle: 'punch',
  status: 'pending',
  file: null,
  error: null,
  ...over,
})

beforeEach(() => {
  store = createStore(':memory:')
})

describe('jobs', () => {
  it('round-trips a job', () => {
    const id = store.createJob({
      url: 'https://x/y',
      title: 'A talk',
      kind: 'youtube',
      options: DEFAULT_OPTIONS,
    })

    expect(store.getJob(id)).toMatchObject({
      url: 'https://x/y',
      title: 'A talk',
      kind: 'youtube',
      stage: 'queued',
    })
  })

  it('returns null for a job that does not exist', () => {
    expect(store.getJob('nope')).toBeNull()
  })

  it('lists newest first', () => {
    const first = store.createJob({ url: 'a', title: 'a', kind: 'youtube', options: DEFAULT_OPTIONS })
    const second = store.createJob({ url: 'b', title: 'b', kind: 'youtube', options: DEFAULT_OPTIONS })
    expect(store.listJobs().map((j) => j.id)).toEqual([second, first])
  })

  it('patches only the fields it was given', () => {
    const id = store.createJob({ url: 'a', title: 'Original', kind: 'youtube', options: DEFAULT_OPTIONS })

    store.patchJob(id, { stage: 'render', pct: 40 })
    expect(store.getJob(id)).toMatchObject({ stage: 'render', pct: 40, title: 'Original' })
  })

  it('can clear an error back to null', () => {
    const id = store.createJob({ url: 'a', title: 'a', kind: 'youtube', options: DEFAULT_OPTIONS })
    store.patchJob(id, { error: 'broke' })
    store.patchJob(id, { error: null })
    expect(store.getJob(id)?.error).toBeNull()
  })

  it('fills in an option a stored job predates', () => {
    const id = store.createJob({
      url: 'a',
      title: 'a',
      kind: 'youtube',
      // A row written before `whisperModel` existed.
      options: { clipCount: 3 } as never,
    })
    expect(store.getJob(id)?.options.whisperModel).toBe(DEFAULT_OPTIONS.whisperModel)
  })

  it('reports jobs a restart interrupted', () => {
    const running = store.createJob({ url: 'a', title: 'a', kind: 'youtube', options: DEFAULT_OPTIONS })
    const finished = store.createJob({ url: 'b', title: 'b', kind: 'youtube', options: DEFAULT_OPTIONS })

    store.patchJob(running, { stage: 'render' })
    store.patchJob(finished, { stage: 'done' })

    expect(store.interruptedJobs()).toEqual([running])
  })

  it('deletes a job and its clips together', () => {
    const id = store.createJob({ url: 'a', title: 'a', kind: 'youtube', options: DEFAULT_OPTIONS })
    store.putClips(id, [clip({ jobId: id })])

    store.deleteJob(id)

    expect(store.getJob(id)).toBeNull()
    expect(store.listClips(id)).toEqual([])
  })
})

describe('clips', () => {
  let jobId: string

  beforeEach(() => {
    jobId = store.createJob({ url: 'a', title: 'a', kind: 'youtube', options: DEFAULT_OPTIONS })
  })

  it('round-trips every field, including the nested ones', () => {
    store.putClips(jobId, [clip({ jobId })])
    const [stored] = store.listClips(jobId)

    expect(stored.dimensions.hook).toBe(8)
    expect(stored.breakdown.modifiers[0].label).toBe('well sized')
    expect(stored.words).toEqual([{ t: 0, d: 0.4, text: 'hello' }])
  })

  it('replaces the previous set rather than appending to it', () => {
    store.putClips(jobId, [clip({ id: 'a', jobId }), clip({ id: 'b', jobId, index: 1 })])
    store.putClips(jobId, [clip({ id: 'c', jobId })])

    expect(store.listClips(jobId).map((c) => c.id)).toEqual(['c'])
  })

  it('lists in rank order', () => {
    store.putClips(jobId, [
      clip({ id: 'second', jobId, index: 1 }),
      clip({ id: 'first', jobId, index: 0 }),
    ])
    expect(store.listClips(jobId).map((c) => c.id)).toEqual(['first', 'second'])
  })

  it('patches a clip without disturbing its siblings', () => {
    store.putClips(jobId, [clip({ id: 'a', jobId }), clip({ id: 'b', jobId, index: 1 })])
    store.patchClip('a', { status: 'ready', file: 'clip-0.mp4' })

    expect(store.getClip('a')).toMatchObject({ status: 'ready', file: 'clip-0.mp4' })
    expect(store.getClip('b')?.status).toBe('pending')
  })

  it('keeps a re-derived word list', () => {
    store.putClips(jobId, [clip({ jobId })])
    store.patchClip('clip-1', { words: [{ t: 1, d: 2, text: 'new' }] })

    expect(store.getClip('clip-1')?.words).toEqual([{ t: 1, d: 2, text: 'new' }])
  })

  it('returns null for a clip that does not exist', () => {
    expect(store.getClip('nope')).toBeNull()
  })

  it('does nothing when handed an empty patch', () => {
    store.putClips(jobId, [clip({ jobId })])
    store.patchClip('clip-1', {})
    expect(store.getClip('clip-1')?.title).toBe('A clip')
  })
})

describe('settings', () => {
  it('round-trips values', () => {
    store.putSettings({ llm_model: 'gemma', llm_base_url: 'http://x/v1' })
    expect(store.getSettings()).toEqual({ llm_model: 'gemma', llm_base_url: 'http://x/v1' })
  })

  it('overwrites an existing value', () => {
    store.putSettings({ llm_model: 'one' })
    store.putSettings({ llm_model: 'two' })
    expect(store.getSettings().llm_model).toBe('two')
  })

  it('treats empty as "remove", so the .env can show through again', () => {
    store.putSettings({ llm_api_key: 'sk-secret' })
    store.putSettings({ llm_api_key: '' })
    expect(store.getSettings().llm_api_key).toBeUndefined()
  })

  it('starts empty', () => {
    expect(store.getSettings()).toEqual({})
  })
})
