import {
  describeAuthFailure,
  describeHealth,
  parseModelIds,
  type HealthReport,
} from './llm'
import type { LlmConfig } from './types'

/**
 * Ask the provider whether this config actually works.
 *
 * Shared by /api/health and /api/settings so that saving a provider and
 * checking one can never disagree — the dialog used to save a config that
 * failed on the very next request and close as if it had succeeded.
 */
export async function probeConfig(
  cfg: LlmConfig,
  timeoutMs = 6000,
  deep = false,
): Promise<HealthReport> {
  try {
    const res = await fetch(`${cfg.baseUrl}/models`, {
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (res.status === 401 || res.status === 403) {
      return describeAuthFailure(cfg, res.status)
    }

    // Not every OpenAI-compatible provider implements /models. That is not a
    // failure — it only means the model can't be verified before first use.
    if (res.status === 404 || res.status === 405) {
      return {
        ok: true,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        detail: 'reachable (provider does not list models)',
      }
    }

    if (!res.ok) {
      return {
        ok: false,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        detail: `endpoint returned ${res.status}`,
      }
    }

    const body = await res.json().catch(() => null)
    const listed = describeHealth(cfg, parseModelIds(body))
    if (!listed.ok || !deep) return listed

    return probeCompletion(cfg, timeoutMs)
  } catch (err) {
    return {
      ok: false,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      detail: (err as Error).message,
    }
  }
}

/**
 * Being listed is not the same as being allowed.
 *
 * Google's endpoint lists gemini-2.5-pro for every key, but a free key gets
 * HTTP 429 "you exceeded your current quota" on the first completion — the
 * model has no free allowance at all. Health said "ready" and every deck then
 * failed 70 seconds later, after the retry budget burned down.
 *
 * So when it matters — the moment somebody picks a model and clicks Save —
 * spend one token proving the whole path instead of half of it.
 */
async function probeCompletion(
  cfg: LlmConfig,
  timeoutMs: number,
): Promise<HealthReport> {
  const base = { baseUrl: cfg.baseUrl, model: cfg.model }

  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      // One token. We are checking permission, not output — a reasoning model
      // answering `finish_reason: length` here is still a working model.
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (res.ok) return { ...base, ok: true, detail: 'ready' }

    if (res.status === 429) {
      return {
        ...base,
        ok: false,
        detail:
          `"${cfg.model}" is listed by this provider but your key has no quota ` +
          `for it (HTTP 429). On a free tier that usually means the model is ` +
          `paid-only — try a smaller or "flash" model.`,
      }
    }

    if (res.status === 401 || res.status === 403) {
      return describeAuthFailure(cfg, res.status)
    }

    return {
      ...base,
      ok: false,
      detail: `"${cfg.model}" is listed, but a test request returned ${res.status}.`,
    }
  } catch (err) {
    // The listing already succeeded, so the endpoint is reachable. Don't fail
    // a save because one extra probe was slow.
    return { ...base, ok: true, detail: `ready (test call failed: ${(err as Error).message})` }
  }
}
