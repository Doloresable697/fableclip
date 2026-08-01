'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ClipCard } from '@/components/ClipCard'
import { ClipEditor } from '@/components/ClipEditor'
import { isRunning, Pipeline } from '@/components/Pipeline'
import { Setup, type Settings } from '@/components/Setup'
import {
  Alert,
  Captions,
  ClipMark,
  Cog,
  Frame,
  Link,
  Scissors,
  Sliders,
  Spinner,
  Trash,
  Upload,
} from '@/components/Icons'
import { DEFAULT_OPTIONS, type CaptionStyle, type Clip, type Job, type JobOptions, type ReframeMode } from '@/lib/types'

interface Health {
  ok: boolean
  model: string
  detail: string
}

const REFRAMES: Array<[ReframeMode, string]> = [
  ['crop', 'Crop'],
  ['blur', 'Blur'],
  ['original', '16:9'],
]

const STYLES: Array<[CaptionStyle, string]> = [
  ['punch', 'Punch'],
  ['clean', 'Clean'],
  ['chunky', 'Chunky'],
  ['condensed', 'Cond.'],
  ['none', 'None'],
]

const ago = (iso: string): string => {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

export default function Page() {
  const [url, setUrl] = useState('')
  const [options, setOptions] = useState<JobOptions>(DEFAULT_OPTIONS)
  const [jobs, setJobs] = useState<Job[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [clips, setClips] = useState<Clip[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [uploadPct, setUploadPct] = useState<number | null>(null)

  const [settings, setSettings] = useState<Settings | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [showSetup, setShowSetup] = useState(false)

  const fileRef = useRef<HTMLInputElement>(null)

  const loadSettings = useCallback(async () => {
    const [s, h] = await Promise.all([
      fetch('/api/settings').then((r) => r.json() as Promise<Settings>),
      fetch('/api/health').then((r) => r.json() as Promise<Health>),
    ])
    setSettings(s)
    setHealth(h)
  }, [])

  const loadJobs = useCallback(async () => {
    const data = (await fetch('/api/jobs').then((r) => r.json())) as { jobs: Job[] }
    setJobs(data.jobs)
    return data.jobs
  }, [])

  useEffect(() => {
    void loadSettings()
    void loadJobs().then((list) => {
      if (list.length > 0) setActiveId((current) => current ?? list[0].id)
    })
  }, [loadSettings, loadJobs])

  /**
   * Poll while there is work happening, and stop when there is not.
   *
   * A socket would be tidier and is not worth a dependency: this is one
   * request a second against localhost, only while a job is actually running,
   * and it survives the page being reloaded mid-run without any reconnect
   * logic at all.
   */
  useEffect(() => {
    if (!activeId) {
      setJob(null)
      setClips([])
      return
    }

    let live = true
    let timer: ReturnType<typeof setTimeout>

    const tick = async () => {
      try {
        const res = await fetch(`/api/jobs/${activeId}`)
        if (!res.ok) return

        const data = (await res.json()) as { job: Job; clips: Clip[] }
        if (!live) return

        setJob(data.job)
        setClips(data.clips)

        if (isRunning(data.job)) {
          timer = setTimeout(tick, 1000)
        } else {
          void loadJobs()
        }
      } catch {
        // A dropped poll is not worth showing; the next one will succeed.
        if (live) timer = setTimeout(tick, 2000)
      }
    }

    void tick()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [activeId, loadJobs])

  async function start() {
    if (!url.trim() || starting) return

    setStarting(true)
    setError(null)

    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, options }),
      })
      const data = (await res.json()) as { id?: string; error?: string }

      if (!res.ok || !data.id) {
        setError(data.error ?? 'Could not start.')
        return
      }

      setUrl('')
      setActiveId(data.id)
      await loadJobs()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setStarting(false)
    }
  }

  /**
   * Upload with XMLHttpRequest rather than fetch, for one reason: fetch cannot
   * report how far a request body has got. Watching a two-gigabyte recording
   * upload with no progress at all is indistinguishable from a hang.
   */
  function upload(file: File) {
    setError(null)
    setUploadPct(0)

    const request = new XMLHttpRequest()
    request.open('POST', '/api/jobs/upload')
    request.setRequestHeader('x-filename', file.name)
    request.setRequestHeader('x-options', JSON.stringify(options))

    request.upload.onprogress = (e) => {
      if (e.lengthComputable) setUploadPct((e.loaded / e.total) * 100)
    }

    request.onload = () => {
      setUploadPct(null)
      try {
        const data = JSON.parse(request.responseText) as { id?: string; error?: string }
        if (request.status >= 400 || !data.id) {
          setError(data.error ?? 'Upload failed.')
          return
        }
        setActiveId(data.id)
        void loadJobs()
      } catch {
        setError('The server sent back something unreadable.')
      }
    }

    request.onerror = () => {
      setUploadPct(null)
      setError('Upload failed.')
    }

    request.send(file)
  }

  async function cancel() {
    if (!activeId) return
    await fetch(`/api/jobs/${activeId}/cancel`, { method: 'POST' })
  }

  async function remove(id: string) {
    await fetch(`/api/jobs/${id}`, { method: 'DELETE' })
    const list = await loadJobs()
    if (activeId === id) setActiveId(list[0]?.id ?? null)
  }

  const editingClip = clips.find((c) => c.id === editing) ?? null
  const ready = clips.filter((c) => c.status === 'ready').length
  const connected = health?.ok === true

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <ClipMark size={20} />
          fableclip
          <span className="brand-sub">long video in, shorts out</span>
        </div>

        <div className="topbar-spacer" />

        <button className="conn" onClick={() => setShowSetup(true)}>
          <span
            className={`conn-dot${connected ? ' is-ok' : health ? ' is-bad' : ''}`}
          />
          {health?.model ?? 'no model'}
        </button>

        <button
          className="icon-btn"
          onClick={() => setShowSetup(true)}
          aria-label="Model settings"
        >
          <Cog size={15} />
        </button>
      </header>

      <main className="main">
        <div className="hero">
          <h1>Every good moment, cut and captioned.</h1>
          <p>
            Paste a link. fableclip finds the passages worth posting, cuts them to
            9:16, burns in word-by-word captions, and tells you why each one
            scored what it did.
          </p>
        </div>

        <div className="compose">
          <div className="compose-row">
            <Link size={16} />
            <input
              className="compose-input"
              value={url}
              placeholder="https://www.youtube.com/watch?v=…"
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void start()}
              spellCheck={false}
              autoComplete="off"
            />

            <button
              className="ghost"
              onClick={() => fileRef.current?.click()}
              disabled={uploadPct !== null}
              title="Use a file from this machine"
            >
              <Upload size={13} />
              {uploadPct === null ? 'File' : `${Math.round(uploadPct)}%`}
            </button>

            <input
              ref={fileRef}
              type="file"
              accept="video/mp4,video/x-matroska,video/webm,video/quicktime,.mp4,.mkv,.webm,.mov"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) upload(file)
                e.target.value = ''
              }}
            />

            <button className="go" onClick={() => void start()} disabled={starting || !url.trim()}>
              {starting ? <Spinner size={13} /> : <Scissors size={13} />}
              Clip it
            </button>
          </div>

          <div className="compose-opts">
            <span className="opt">
              <Sliders size={13} />
              clips
              <span className="stepper">
                <button
                  onClick={() =>
                    setOptions((o) => ({ ...o, clipCount: Math.max(1, o.clipCount - 1) }))
                  }
                >
                  −
                </button>
                <span>{options.clipCount}</span>
                <button
                  onClick={() =>
                    setOptions((o) => ({ ...o, clipCount: Math.min(20, o.clipCount + 1) }))
                  }
                >
                  +
                </button>
              </span>
            </span>

            <span className="opt-sep" />

            <span className="opt">
              length
              <span className="seg">
                {[
                  [15, 30, '15–30s'],
                  [20, 60, '20–60s'],
                  [45, 90, '45–90s'],
                ].map(([min, max, label]) => (
                  <button
                    key={label as string}
                    className={
                      options.minSeconds === min && options.maxSeconds === max ? 'is-on' : ''
                    }
                    onClick={() =>
                      setOptions((o) => ({
                        ...o,
                        minSeconds: min as number,
                        maxSeconds: max as number,
                      }))
                    }
                  >
                    {label as string}
                  </button>
                ))}
              </span>
            </span>

            <span className="opt-sep" />

            <span className="opt">
              <Frame size={13} />
              <span className="seg">
                {REFRAMES.map(([id, label]) => (
                  <button
                    key={id}
                    className={options.reframe === id ? 'is-on' : ''}
                    onClick={() => setOptions((o) => ({ ...o, reframe: id }))}
                  >
                    {label}
                  </button>
                ))}
              </span>
            </span>

            <span className="opt-sep" />

            <span className="opt">
              <Captions size={13} />
              <span className="seg">
                {STYLES.map(([id, label]) => (
                  <button
                    key={id}
                    className={options.captionStyle === id ? 'is-on' : ''}
                    onClick={() => setOptions((o) => ({ ...o, captionStyle: id }))}
                  >
                    {label}
                  </button>
                ))}
              </span>
            </span>
          </div>
        </div>

        {!connected && health && (
          <p className="hint">
            No model connected yet — {health.detail}{' '}
            <button
              className="chip"
              style={{ verticalAlign: 'middle' }}
              onClick={() => setShowSetup(true)}
            >
              Connect one
            </button>
          </p>
        )}

        {error && (
          <div className="banner">
            <Alert size={14} />
            <span>{error}</span>
          </div>
        )}

        {job && <Pipeline job={job} onCancel={() => void cancel()} />}

        {clips.length > 0 && (
          <>
            <div className="section-head">
              <h2>Clips</h2>
              <span>
                {ready} of {clips.length} rendered · ranked by score
              </span>
            </div>

            <div className="grid">
              {clips.map((clip, i) => (
                <ClipCard
                  key={clip.id}
                  clip={clip}
                  rank={i}
                  onEdit={() => setEditing(clip.id)}
                />
              ))}
            </div>
          </>
        )}

        {jobs.length > 0 && (
          <>
            <div className="section-head">
              <h2>Runs</h2>
              <span>{jobs.length} on this machine</span>
            </div>

            <div className="history">
              {jobs.map((entry) => (
                <div
                  key={entry.id}
                  className={`hist${entry.id === activeId ? ' is-on' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => setActiveId(entry.id)}
                  onKeyDown={(e) => e.key === 'Enter' && setActiveId(entry.id)}
                >
                  <span
                    className={`pill${
                      entry.stage === 'done'
                        ? ' is-done'
                        : entry.stage === 'failed'
                          ? ' is-bad'
                          : isRunning(entry)
                            ? ' is-run'
                            : ''
                    }`}
                  >
                    {entry.stage}
                  </span>
                  <span className="hist-name">{entry.title}</span>
                  <span className="hist-meta">{ago(entry.createdAt)}</span>
                  <button
                    className="icon-btn"
                    aria-label="Delete run"
                    onClick={(e) => {
                      e.stopPropagation()
                      void remove(entry.id)
                    }}
                  >
                    <Trash size={13} />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {jobs.length === 0 && !job && (
          <div className="empty" style={{ marginTop: 34 }}>
            Nothing clipped yet. Paste a link above — a talk, an interview, a
            podcast. Anything with people saying things.
          </div>
        )}

        <p className="hint" style={{ marginTop: 40 }}>
          No account, no upload to anyone, no watermark. Everything above ran on
          this machine against your own model.{' '}
          <a href="https://github.com/micahc123/slopsource" target="_blank" rel="noreferrer">
            Slopsource
          </a>{' '}
          drop #007.
        </p>
      </main>

      {editingClip && job && (
        <ClipEditor
          clip={editingClip}
          maxSeconds={job.duration}
          onClose={() => setEditing(null)}
          onSaved={(updated) =>
            setClips((list) => list.map((c) => (c.id === updated.id ? updated : c)))
          }
        />
      )}

      {showSetup && (
        <div
          className="scrim"
          onPointerDown={(e) => e.target === e.currentTarget && setShowSetup(false)}
        >
          <Setup
            settings={settings}
            onClose={() => setShowSetup(false)}
            onSaved={() => {
              setShowSetup(false)
              void loadSettings()
            }}
          />
        </div>
      )}
    </div>
  )
}
