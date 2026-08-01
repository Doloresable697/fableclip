import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, type Store } from '@/lib/store'
import { DEFAULT_OPTIONS } from '@/lib/types'

/**
 * The queue reaches for the app-wide store and for the pipeline, so both are
 * replaced here. What is under test is the bookkeeping — which jobs a restart
 * sweep is allowed to touch — not the work itself.
 */
let store: Store

vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store')
  return { ...actual, getStore: () => store }
})

vi.mock('@/lib/pipeline', () => ({
  runJob: vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }),
}))

const newJob = (): string =>
  store.createJob({
    url: 'https://x/y',
    title: 'a talk',
    kind: 'youtube',
    options: DEFAULT_OPTIONS,
  })

/** A fresh module registry per test, because the queue keeps process state. */
async function freshQueue() {
  vi.resetModules()
  Reflect.deleteProperty(globalThis, Symbol.for('fableclip.queue'))
  return import('@/lib/queue')
}

beforeEach(() => {
  store = createStore(':memory:')
})

describe('the restart sweep', () => {
  it('fails a job left mid-stage by a previous process', async () => {
    const stranded = newJob()
    store.patchJob(stranded, { stage: 'render', pct: 40 })

    const { sweepInterrupted } = await freshQueue()
    sweepInterrupted()

    const job = store.getJob(stranded)
    expect(job?.stage).toBe('failed')
    expect(job?.error).toMatch(/restarted/i)
  })

  it('leaves a finished job alone', async () => {
    const done = newJob()
    store.patchJob(done, { stage: 'done' })

    const { sweepInterrupted } = await freshQueue()
    sweepInterrupted()

    expect(store.getJob(done)?.stage).toBe('done')
  })

  it('runs once, not on every call', async () => {
    const { sweepInterrupted } = await freshQueue()
    sweepInterrupted()

    // A job that starts *after* the sweep must not be caught by a later one.
    const later = newJob()
    store.patchJob(later, { stage: 'fetch' })
    sweepInterrupted()

    expect(store.getJob(later)?.stage).toBe('fetch')
  })

  it('does not sweep up the job it is being asked to start', async () => {
    // The bug this exists for: a job is written as `queued` before it reaches
    // the queue, so a fresh process's first enqueue used to mark the very job
    // it was starting as abandoned — and then run it anyway, leaving a live
    // job carrying "fableclip restarted while this job was running".
    const id = newJob()

    const { enqueue } = await freshQueue()
    enqueue(id)

    const job = store.getJob(id)
    expect(job?.error).toBeNull()
    expect(job?.stage).not.toBe('failed')
  })

  it('still sweeps a genuinely stranded job on that same first enqueue', async () => {
    const stranded = newJob()
    store.patchJob(stranded, { stage: 'analyze' })
    const fresh = newJob()

    const { enqueue } = await freshQueue()
    enqueue(fresh)

    expect(store.getJob(stranded)?.stage).toBe('failed')
    expect(store.getJob(fresh)?.stage).not.toBe('failed')
  })
})

describe('cancel', () => {
  it('reports nothing to cancel for a job the queue never saw', async () => {
    const { cancel } = await freshQueue()
    expect(cancel('not-a-job')).toBe(false)
  })

  it('drops a queued job and marks it cancelled', async () => {
    const first = newJob()
    const second = newJob()

    const { enqueue, cancel } = await freshQueue()
    enqueue(first)
    enqueue(second)

    // `first` is running; `second` is still waiting its turn.
    expect(cancel(second)).toBe(true)
    expect(store.getJob(second)?.stage).toBe('cancelled')
  })
})

describe('enqueue', () => {
  it('ignores a job already queued', async () => {
    const id = newJob()
    const { enqueue, queueStatus } = await freshQueue()

    enqueue(id)
    enqueue(id)
    enqueue(id)

    expect(queueStatus().pending).toBe(0)
  })

  it('runs one job at a time', async () => {
    const ids = [newJob(), newJob(), newJob()]
    const { enqueue, queueStatus } = await freshQueue()

    for (const id of ids) enqueue(id)

    const status = queueStatus()
    expect(status.running).toBe(ids[0])
    expect(status.pending).toBe(2)
  })
})
