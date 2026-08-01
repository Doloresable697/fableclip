'use client'

import { useEffect, useState } from 'react'
import { Check, Spinner } from './Icons'

export interface Settings {
  baseUrl: string
  model: string
  hasKey: boolean
  keyFromEnv: boolean
}

interface Preset {
  id: string
  label: string
  baseUrl: string
  model: string
  needsKey: boolean
  keyUrl?: string
  note: string
}

/**
 * Every hosted provider requires a free account — none of them allow keyless
 * completions, verified by request. So the honest framing is "free of charge,
 * one signup", with local as the no-signup option.
 */
export const PRESETS: Preset[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'google/gemma-4-26b-a4b-it:free',
    needsKey: true,
    keyUrl: 'https://openrouter.ai/keys',
    note: 'Widest choice of free models. Free key, no card.',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    needsKey: true,
    keyUrl: 'https://console.groq.com/keys',
    note: 'Fastest of the free tiers. Free key, no card.',
  },
  {
    id: 'google',
    label: 'Google AI Studio',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    // Measured: on a free key gemini-2.5-flash completes, while
    // gemini-2.0-flash and gemini-2.5-pro both return 429 "exceeded your
    // current quota" — they carry no free allowance.
    model: 'gemini-2.5-flash',
    needsKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    note: 'Huge context. Free key, no card. Use a flash model.',
  },
  {
    id: 'local',
    label: 'Local (Ollama)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
    needsKey: false,
    note: 'No signup, nothing leaves your machine. Needs a few GB of disk.',
  },
]

interface Props {
  settings: Settings | null
  onSaved: () => void
  onClose?: () => void
}

export function Setup({ settings, onSaved, onClose }: Props) {
  const [presetId, setPresetId] = useState('openrouter')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0]

  useEffect(() => {
    if (!settings) return
    const match = PRESETS.find((p) => settings.baseUrl.startsWith(p.baseUrl))
    if (match) setPresetId(match.id)
    setBaseUrl(settings.baseUrl)
    setModel(settings.model)
  }, [settings])

  function choose(id: string) {
    const p = PRESETS.find((x) => x.id === id)
    if (!p) return
    setPresetId(id)
    setBaseUrl(p.baseUrl)
    setModel(p.model)
    setError(null)
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const body: Record<string, string> = { baseUrl, model }
      // Only send the key when one was typed, so saving other fields does
      // not wipe a key that is already stored.
      if (apiKey.trim()) body.apiKey = apiKey.trim()

      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = (await res.json()) as {
        error?: string
        ok?: boolean
        detail?: string
      }

      if (!res.ok) {
        setError(data.error ?? 'Could not save.')
        return
      }

      // Saved, but it has to actually work before we get out of the way.
      if (data.ok === false) {
        setError(data.detail ?? 'Saved, but the provider did not accept it.')
        return
      }

      setApiKey('')
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const keySatisfied = !preset.needsKey || !!apiKey.trim() || !!settings?.hasKey

  return (
    <div className="setup" role="dialog" aria-label="Model setup">
      <div className="setup-head">
        <h2>Connect a model</h2>
        <p>
          There is no keyless free model — every hosted provider needs a free
          account. Pick one, or run it locally with no signup at all.
        </p>
      </div>

      <div className="setup-presets">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            className={`setup-preset${p.id === presetId ? ' is-on' : ''}`}
            onClick={() => choose(p.id)}
          >
            <span className="setup-preset-top">
              {p.label}
              {p.id === presetId && <Check size={13} />}
            </span>
            <span className="setup-preset-note">{p.note}</span>
          </button>
        ))}
      </div>

      <div className="setup-fields">
        {preset.needsKey && (
          <label className="setup-field">
            <span>
              API key
              {settings?.hasKey && (
                <em>
                  {' '}
                  · one is already saved
                  {settings.keyFromEnv ? ' (from .env)' : ''}
                </em>
              )}
            </span>
            {settings?.keyFromEnv && preset.needsKey && (
              <em className="setup-warn">
                The saved key comes from .env. If it belongs to a different
                provider, paste one for {preset.label} here.
              </em>
            )}
            <input
              type="password"
              value={apiKey}
              placeholder={settings?.hasKey ? '•••••••• (leave blank to keep)' : 'paste your key'}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            {preset.keyUrl && (
              <a href={preset.keyUrl} target="_blank" rel="noreferrer">
                Get a free key →
              </a>
            )}
          </label>
        )}

        <label className="setup-field">
          <span>Model</span>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            spellCheck={false}
          />
        </label>

        <label className="setup-field">
          <span>Endpoint</span>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            spellCheck={false}
          />
        </label>
      </div>

      {error && <p className="setup-error">{error}</p>}

      <div className="setup-actions">
        {onClose && (
          <button className="setup-cancel" onClick={onClose}>
            Cancel
          </button>
        )}
        <button
          className="prompt-send"
          onClick={save}
          disabled={saving || !keySatisfied || !baseUrl || !model}
        >
          {saving && <Spinner size={14} />}
          {saving ? 'Saving' : 'Save and connect'}
        </button>
      </div>

      {preset.id === 'local' && (
        <p className="setup-hint">
          Needs Ollama running: <code>ollama serve</code> then{' '}
          <code>ollama pull {model}</code>. Pick an instruct model, not a coder
          model — this app writes prose, not source.
        </p>
      )}
    </div>
  )
}
