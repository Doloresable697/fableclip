'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, Chevron } from './Icons'

export interface ModelOption {
  id: string
  name: string
  context: number
  free: boolean
}

interface Props {
  models: ModelOption[]
  value: string
  disabled?: boolean
  onChange: (id: string) => void
}

const shortContext = (n: number): string =>
  n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

/** Drops the vendor prefix and the `:free` suffix for display. */
export const shortModel = (id: string): string =>
  (id.split('/').pop() ?? id).replace(/:free$/, '')

export function ModelPicker({ models, value, disabled, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const selectedIndex = Math.max(
    0,
    models.findIndex((m) => m.id === value),
  )
  const selected = models[selectedIndex]

  // Close on outside click and on Escape — both are expected of a popover,
  // and neither comes free once you stop using a native <select>.
  useEffect(() => {
    if (!open) return

    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (open) setActive(selectedIndex)
  }, [open, selectedIndex])

  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  function commit(index: number) {
    const model = models[index]
    if (model) onChange(model.id)
    setOpen(false)
  }

  function onTriggerKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
      e.preventDefault()
      setOpen(true)
    }
  }

  function onListKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, models.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      commit(active)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActive(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActive(models.length - 1)
    }
  }

  if (models.length === 0) return null

  return (
    <div className="picker" ref={rootRef}>
      <button
        type="button"
        className="picker-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKey}
      >
        <span className="picker-trigger-label">
          {selected ? shortModel(selected.id) : 'model'}
        </span>
        <Chevron size={12} className="picker-chevron" />
      </button>

      {open && (
        <div
          className="picker-menu"
          role="listbox"
          aria-label="Model"
          tabIndex={-1}
          ref={listRef}
          onKeyDown={onListKey}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
        >
          <div className="picker-menu-head">
            Free models · {models.length}
          </div>

          {models.map((m, i) => (
            <div
              key={m.id}
              data-index={i}
              role="option"
              aria-selected={m.id === value}
              className={`picker-option${i === active ? ' is-active' : ''}`}
              onPointerEnter={() => setActive(i)}
              onClick={() => commit(i)}
            >
              <span className="picker-check">
                {m.id === value ? <Check size={13} /> : null}
              </span>

              <span className="picker-option-main">
                <span className="picker-option-name">{shortModel(m.id)}</span>
                <span className="picker-option-vendor">
                  {m.id.includes('/') ? m.id.split('/')[0] : 'provider'}
                </span>
              </span>

              {m.context > 0 && (
                <span className="picker-ctx">{shortContext(m.context)}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
