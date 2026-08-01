'use client'

import { Alert, Check, Spinner, Stop } from './Icons'
import type { Job } from '@/lib/types'

const STEPS = [
  { id: 'fetch', label: 'Fetch' },
  { id: 'transcribe', label: 'Transcribe' },
  { id: 'analyze', label: 'Analyse' },
  { id: 'render', label: 'Render' },
] as const

const ORDER: Record<string, number> = {
  queued: 0,
  fetch: 0,
  transcribe: 1,
  analyze: 2,
  render: 3,
  done: 4,
  failed: -1,
  cancelled: -1,
}

export const isRunning = (job: Job): boolean =>
  ['queued', 'fetch', 'transcribe', 'analyze', 'render'].includes(job.stage)

const clock = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

interface Props {
  job: Job
  onCancel: () => void
}

/**
 * The five stages, and where the run is in them.
 *
 * A single bar would be a lie here: downloading, transcribing, reading and
 * rendering take wildly different times and none of them can be predicted
 * ahead of the others. Naming the stage the machine is in — and what it is
 * doing inside that stage — is honest about a wait that can be several
 * minutes, where "47%" would not be.
 */
export function Pipeline({ job, onCancel }: Props) {
  const current = ORDER[job.stage] ?? 0
  const failed = job.stage === 'failed'
  const cancelled = job.stage === 'cancelled'
  const running = isRunning(job)

  return (
    <section className="run">
      <div className="run-head">
        <div className="run-title">{job.title}</div>
        {job.duration > 0 && <div className="run-meta">{clock(job.duration)}</div>}
        {running && (
          <button className="chip" onClick={onCancel}>
            <Stop size={12} />
            Stop
          </button>
        )}
      </div>

      <div className="stages">
        {STEPS.map((step, i) => {
          const done = current > i || job.stage === 'done'
          const now = running && current === i
          const bad = (failed || cancelled) && current === i

          return (
            <div key={step.id} style={{ display: 'contents' }}>
              <div
                className={`stage${done ? ' is-done' : ''}${now ? ' is-now' : ''}${
                  bad ? ' is-bad' : ''
                }`}
              >
                <span className="stage-dot">
                  {done ? (
                    <Check size={11} />
                  ) : bad ? (
                    <Alert size={11} />
                  ) : now ? (
                    <Spinner size={11} />
                  ) : null}
                </span>
                {step.label}
              </div>
              {i < STEPS.length - 1 && <span className="stage-line" />}
            </div>
          )
        })}
      </div>

      <div className="run-detail">
        <span>
          {failed
            ? (job.error ?? 'Something went wrong.')
            : cancelled
              ? 'Cancelled.'
              : job.stage === 'done'
                ? job.detail
                : job.detail || 'Starting'}
        </span>
        {running && job.pct > 0 && <strong>{Math.round(job.pct)}%</strong>}
      </div>

      <div className="bar">
        <div
          className={`bar-fill${failed ? ' is-bad' : ''}`}
          style={{
            width: `${job.stage === 'done' ? 100 : running ? Math.max(2, job.pct) : failed || cancelled ? 100 : 0}%`,
          }}
        />
      </div>
    </section>
  )
}
