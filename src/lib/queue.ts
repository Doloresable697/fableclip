import { runJob } from './pipeline'
import { getStore } from './store'

interface QueueState {
  pending: string[]
  running: { id: string; controller: AbortController } | null
  swept: boolean
}

/**
 * One worker, one job at a time, in the web process.
 *
 * There is no Redis and no second container on purpose — "one command" is a
 * rule of this repo, and a queue that needs its own service is a second
 * command. The trade is real and worth stating: the work does not survive a
 * restart, which `sweep` below turns into an honest error rather than a job
 * that sits at 40% forever.
 *
 * Serial rather than parallel because every stage here is CPU-bound. Two
 * ffmpeg runs on the same machine finish at the same time as two run one after
 * the other, only with both progress bars lying the whole way.
 */
function state(): QueueState {
  const key = Symbol.for('fableclip.queue')
  const holder = globalThis as unknown as Record<symbol, QueueState | undefined>

  if (!holder[key]) {
    holder[key] = { pending: [], running: null, swept: false }
  }
  return holder[key]
}

/**
 * A job in a working stage at startup was interrupted by a restart, and
 * nothing is going to pick it up. Say so.
 *
 * Anything this process already knows about is skipped. A job is written to
 * the database as `queued` *before* it is handed to the queue, so without that
 * check the very first enqueue of a fresh process sweeps up the job it is
 * being asked to start — which is exactly what happened: a container's first
 * run reported "fableclip restarted while this job was running" while cheerfully
 * transcribing it.
 */
export function sweepInterrupted(): void {
  const queue = state()
  if (queue.swept) return
  queue.swept = true

  const live = new Set(
    [...queue.pending, queue.running?.id].filter((id): id is string => !!id),
  )

  const store = getStore()
  for (const id of store.interruptedJobs()) {
    if (live.has(id)) continue

    store.patchJob(id, {
      stage: 'failed',
      error: 'fableclip restarted while this job was running. Start it again.',
      detail: 'interrupted by a restart',
    })
  }
}

export function enqueue(jobId: string): void {
  const queue = state()

  if (queue.running?.id === jobId || queue.pending.includes(jobId)) return

  // Recorded before the sweep, not after, so this job is one of the ones the
  // sweep knows to leave alone.
  queue.pending.push(jobId)
  sweepInterrupted()
  void pump()
}

async function pump(): Promise<void> {
  const queue = state()
  if (queue.running) return

  const id = queue.pending.shift()
  if (!id) return

  const controller = new AbortController()
  queue.running = { id, controller }

  const store = getStore()

  try {
    await runJob(id, controller.signal)
  } catch (err) {
    const message = (err as Error).message
    const cancelled = controller.signal.aborted || message === 'Cancelled'

    store.patchJob(id, {
      stage: cancelled ? 'cancelled' : 'failed',
      error: cancelled ? null : message,
      detail: cancelled ? 'cancelled' : 'failed',
    })
  } finally {
    queue.running = null
    void pump()
  }
}

/** True if there was something to cancel. */
export function cancel(jobId: string): boolean {
  const queue = state()

  if (queue.running?.id === jobId) {
    queue.running.controller.abort()
    return true
  }

  const index = queue.pending.indexOf(jobId)
  if (index >= 0) {
    queue.pending.splice(index, 1)
    getStore().patchJob(jobId, { stage: 'cancelled', detail: 'cancelled' })
    return true
  }

  return false
}

export function queueStatus(): { running: string | null; pending: number } {
  const queue = state()
  return { running: queue.running?.id ?? null, pending: queue.pending.length }
}
