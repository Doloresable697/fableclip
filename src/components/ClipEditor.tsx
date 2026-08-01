'use client'

import { useEffect, useState } from 'react'
import { Captions, Close, Download, Frame, Refresh, Spinner } from './Icons'
import { ScoreRing } from './ScoreRing'
import { clock } from './ClipCard'
import { scoreLabel } from '@/lib/score'
import type { CaptionStyle, Clip, ReframeMode } from '@/lib/types'

const REFRAMES: Array<[ReframeMode, string]> = [
  ['crop', 'Crop'],
  ['blur', 'Blur fit'],
  ['original', '16:9'],
]

const STYLES: Array<[CaptionStyle, string]> = [
  ['punch', 'Punch'],
  ['clean', 'Clean'],
  ['chunky', 'Chunky'],
  ['condensed', 'Condensed'],
  ['none', 'None'],
]

interface Props {
  clip: Clip
  maxSeconds: number
  onClose: () => void
  onSaved: (clip: Clip) => void
}

/**
 * Change a clip, then re-cut it.
 *
 * Editing and re-rendering are one button on purpose. The two are never
 * usefully separate — a saved trim that has not been rendered is a card
 * describing a file that does not match it — so "Apply" does both and the
 * card cannot get out of step with its own MP4.
 */
export function ClipEditor({ clip, maxSeconds, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState(clip)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Bumped after a render so the <video> refetches instead of showing the
  // previous cut out of its own cache.
  const [version, setVersion] = useState(0)

  useEffect(() => {
    setDraft(clip)
    setError(null)
  }, [clip])

  const dirty =
    draft.start !== clip.start ||
    draft.end !== clip.end ||
    draft.reframe !== clip.reframe ||
    draft.focus !== clip.focus ||
    draft.captionStyle !== clip.captionStyle ||
    draft.title !== clip.title

  const length = draft.end - draft.start

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  function nudge(edge: 'start' | 'end', delta: number) {
    setDraft((d) => {
      const next = { ...d }
      if (edge === 'start') {
        next.start = Math.max(0, Math.min(d.end - 1, d.start + delta))
      } else {
        next.end = Math.max(d.start + 1, Math.min(maxSeconds || d.end + 60, d.end + delta))
      }
      return next
    })
  }

  async function apply() {
    setBusy(true)
    setError(null)

    try {
      const patch = await fetch(`/api/clips/${clip.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start: draft.start,
          end: draft.end,
          reframe: draft.reframe,
          focus: draft.focus,
          captionStyle: draft.captionStyle,
          title: draft.title,
        }),
      })

      const saved = (await patch.json()) as { clip?: Clip; error?: string }
      if (!patch.ok || !saved.clip) {
        setError(saved.error ?? 'Could not save the change.')
        return
      }

      const rendered = await fetch(`/api/clips/${clip.id}/render`, { method: 'POST' })
      const result = (await rendered.json()) as { clip?: Clip; error?: string }

      if (!rendered.ok || !result.clip) {
        setError(result.error ?? 'The re-render failed.')
        // The edit itself did save, so show what is actually stored.
        onSaved(saved.clip)
        return
      }

      setVersion((v) => v + 1)
      setDraft(result.clip)
      onSaved(result.clip)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const wide = draft.reframe === 'original'
  const ready = draft.status === 'ready' && draft.file

  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="sheet" role="dialog" aria-label="Edit clip">
        <div className="sheet-head">
          <ScoreRing score={draft.score} size={34} label={scoreLabel(draft.score)} />
          <h3>{draft.title}</h3>
          <button className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close">
            <Close size={15} />
          </button>
        </div>

        <div className="editor">
          <div className={`editor-preview${wide ? ' is-wide' : ''}`}>
            {ready ? (
              <video
                key={version}
                src={`/api/clips/${clip.id}/file?v=${version}`}
                poster={`/api/clips/${clip.id}/thumb?v=${version}`}
                controls
                playsInline
                preload="metadata"
              />
            ) : (
              <span className="card-pending">Not rendered yet</span>
            )}
          </div>

          <div className="editor-fields">
            <div className="field">
              <label htmlFor="clip-title">Title</label>
              <input
                id="clip-title"
                className="text-input"
                value={draft.title}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              />
            </div>

            <div className="field">
              <label>
                Trim <em>{length.toFixed(1)}s</em>
              </label>
              <div className="trim">
                <div className="nudge">
                  <button onClick={() => nudge('start', -1)} disabled={busy}>
                    −1s
                  </button>
                  <span>{clock(draft.start)}</span>
                  <button onClick={() => nudge('start', 1)} disabled={busy}>
                    +1s
                  </button>
                </div>
                <div className="nudge">
                  <button onClick={() => nudge('end', -1)} disabled={busy}>
                    −1s
                  </button>
                  <span>{clock(draft.end)}</span>
                  <button onClick={() => nudge('end', 1)} disabled={busy}>
                    +1s
                  </button>
                </div>
              </div>
            </div>

            <div className="field">
              <label>
                <Frame size={13} /> Reframe
              </label>
              <div className="seg">
                {REFRAMES.map(([id, label]) => (
                  <button
                    key={id}
                    className={draft.reframe === id ? 'is-on' : ''}
                    onClick={() => setDraft((d) => ({ ...d, reframe: id }))}
                    disabled={busy}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {draft.reframe === 'crop' && (
              <div className="field">
                <label>
                  Focus
                  <em>
                    {draft.focus === 0
                      ? 'centre'
                      : `${draft.focus < 0 ? 'left' : 'right'} ${Math.round(Math.abs(draft.focus) * 100)}%`}
                  </em>
                </label>
                <input
                  type="range"
                  min={-1}
                  max={1}
                  step={0.05}
                  value={draft.focus}
                  disabled={busy}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, focus: Number(e.target.value) }))
                  }
                />
              </div>
            )}

            <div className="field">
              <label>
                <Captions size={13} /> Captions
              </label>
              <div className="seg">
                {STYLES.map(([id, label]) => (
                  <button
                    key={id}
                    className={draft.captionStyle === id ? 'is-on' : ''}
                    onClick={() => setDraft((d) => ({ ...d, captionStyle: id }))}
                    disabled={busy}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {error && <p className="setup-error">{error}</p>}

            <div className="editor-actions">
              <button className="go" onClick={apply} disabled={busy}>
                {busy ? <Spinner size={13} /> : <Refresh size={13} />}
                {busy ? 'Rendering' : dirty ? 'Apply and re-cut' : 'Re-cut'}
              </button>

              {ready && (
                <>
                  <a
                    className="ghost"
                    href={`/api/clips/${clip.id}/file?download`}
                    download
                    style={{ textDecoration: 'none' }}
                  >
                    <Download size={13} />
                    MP4
                  </a>
                  <a
                    className="ghost"
                    href={`/api/clips/${clip.id}/srt`}
                    download
                    style={{ textDecoration: 'none' }}
                  >
                    <Download size={13} />
                    SRT
                  </a>
                </>
              )}
            </div>
          </div>
        </div>

        {draft.words.length > 0 && (
          <div className="words">
            <h4>What is said in this clip</h4>
            <p>{draft.words.map((w) => w.text).join(' ')}</p>
          </div>
        )}
      </div>
    </div>
  )
}
