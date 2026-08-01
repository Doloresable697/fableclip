'use client'

import { useState } from 'react'
import { ScoreRing } from './ScoreRing'
import { Chevron, Download, Sliders, Spinner } from './Icons'
import { scoreLabel } from '@/lib/score'
import type { Clip, Dimensions } from '@/lib/types'

const DIMENSION_LABELS: Array<[keyof Dimensions, string]> = [
  ['hook', 'Hook'],
  ['payoff', 'Payoff'],
  ['emotion', 'Emotion'],
  ['clarity', 'Clarity'],
  ['quotability', 'Quotable'],
  ['novelty', 'Novelty'],
]

export const clock = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rest = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`
}

interface Props {
  clip: Clip
  rank: number
  onEdit: () => void
}

export function ClipCard({ clip, rank, onEdit }: Props) {
  const [showWhy, setShowWhy] = useState(false)
  const wide = clip.reframe === 'original'
  const length = clip.end - clip.start

  return (
    <article className="card" style={{ animationDelay: `${Math.min(rank, 8) * 40}ms` }}>
      <div className={`card-media${wide ? ' is-wide' : ''}`}>
        <span className="card-rank">#{rank + 1}</span>
        <span className="card-score">
          <ScoreRing score={clip.score} label={scoreLabel(clip.score)} />
        </span>

        {clip.status === 'ready' && clip.file ? (
          <video
            src={`/api/clips/${clip.id}/file`}
            poster={`/api/clips/${clip.id}/thumb`}
            controls
            preload="none"
            playsInline
          />
        ) : clip.status === 'failed' ? (
          <div className="card-pending">
            <span className="card-err">{clip.error ?? 'Render failed'}</span>
          </div>
        ) : (
          <div className="card-pending">
            {clip.status === 'rendering' ? (
              <>
                <Spinner size={16} />
                Rendering
              </>
            ) : (
              'Not rendered yet'
            )}
          </div>
        )}
      </div>

      <div className="card-body">
        <div className="card-title">{clip.title}</div>
        {clip.hook && <div className="card-hook">{clip.hook}</div>}
        <div className="card-time">
          {clock(clip.start)} – {clock(clip.end)} · {Math.round(length)}s
        </div>

        {showWhy && (
          <div className="why">
            <div className="dims">
              {DIMENSION_LABELS.map(([key, label]) => (
                <div className="dim" key={key}>
                  <span>{label}</span>
                  <span className="dim-bar">
                    <i style={{ width: `${clip.dimensions[key] * 10}%` }} />
                  </span>
                  <span className="dim-val">{clip.dimensions[key]}</span>
                </div>
              ))}
            </div>

            <div className="mods">
              <div className="mod">
                <b>{clip.breakdown.base}</b>
                <span>weighted from the six above</span>
              </div>
              {clip.breakdown.modifiers.map((mod, i) => (
                <div className="mod" key={`${mod.label}-${i}`}>
                  <b className={mod.delta > 0 ? 'is-up' : mod.delta < 0 ? 'is-down' : ''}>
                    {mod.delta > 0 ? `+${mod.delta}` : mod.delta}
                  </b>
                  <span>
                    {mod.label} <em>· {mod.detail}</em>
                  </span>
                </div>
              ))}
            </div>

            {clip.reason && <div className="card-hook">{clip.reason}</div>}
          </div>
        )}

        <div className="card-foot">
          {/* The chevron rotates rather than being swapped for another glyph,
              so the button keeps its width as the panel opens. */}
          <button className="chip" onClick={() => setShowWhy((v) => !v)}>
            <Chevron
              size={11}
              className={showWhy ? 'flip' : undefined}
            />
            {showWhy ? 'Hide' : 'Why'}
          </button>

          <button className="chip" onClick={onEdit}>
            <Sliders size={12} />
            Edit
          </button>

          {clip.status === 'ready' && (
            <a
              className="chip is-primary"
              href={`/api/clips/${clip.id}/file?download`}
              download
              style={{ marginLeft: 'auto', textDecoration: 'none' }}
            >
              <Download size={12} />
              MP4
            </a>
          )}
        </div>
      </div>
    </article>
  )
}
