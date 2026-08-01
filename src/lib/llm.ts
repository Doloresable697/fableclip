import type { ChatMessage, LlmConfig } from './types'

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]']

/**
 * Inside a container, `localhost` is the container — not the machine running
 * Ollama. Rewrite it so the same root .env works on the host and in Docker.
 */
export function resolveBaseUrl(baseUrl: string, inDocker: boolean): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (!inDocker) return trimmed

  try {
    const url = new URL(trimmed)
    if (LOCAL_HOSTS.includes(url.hostname)) {
      url.hostname = 'host.docker.internal'
      return url.toString().replace(/\/+$/, '')
    }
  } catch {
    return trimmed
  }
  return trimmed
}

export function llmConfigFromEnv(): LlmConfig {
  const baseUrl = process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1'
  return {
    baseUrl: resolveBaseUrl(baseUrl, process.env.IN_DOCKER === '1'),
    model: process.env.LLM_MODEL ?? 'qwen2.5-coder:32b',
    apiKey: process.env.LLM_API_KEY || undefined,
  }
}

export interface HealthReport {
  ok: boolean
  baseUrl: string
  model: string
  detail: string
}

const LOOPBACK = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '[::1]',
  'host.docker.internal',
]

/** Whether this endpoint is a model running on the user's own machine. */
export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    return LOOPBACK.includes(new URL(baseUrl).hostname)
  } catch {
    return false
  }
}

/**
 * Turn a /models listing into a verdict.
 *
 * Reachability alone is not health. Ollama answers /models perfectly happily
 * with nothing pulled, so treating a 200 as "ready" shows a green light and
 * then fails on the first generation with a confusing 404. Checking that the
 * configured model is actually present turns that into an instruction — and
 * the instruction differs entirely for a hosted provider versus a local one.
 */
/**
 * Google's OpenAI-compatible endpoint lists ids as `models/gemini-2.5-flash`
 * but accepts either form in a request — both were verified to complete. So
 * an exact string comparison reported "gemini-2.5-pro isn't offered by this
 * provider" while listing `models/gemini-2.5-pro` in the very same sentence.
 *
 * Only the literal `models/` prefix is stripped. A generic "last path
 * segment" comparison would wrongly equate OpenRouter's `google/gemma-3-27b`
 * with some other vendor's `gemma-3-27b`.
 */
function sameModel(a: string, b: string): boolean {
  const strip = (s: string) => s.trim().replace(/^models\//, '')
  return strip(a) === strip(b)
}

export function describeHealth(cfg: LlmConfig, installed: string[]): HealthReport {
  const base = { baseUrl: cfg.baseUrl, model: cfg.model }
  const local = isLocalEndpoint(cfg.baseUrl)

  if (installed.length === 0) {
    return {
      ...base,
      ok: false,
      detail: local
        ? `Reachable, but it reports no models. Run \`ollama pull ${cfg.model}\`.`
        : `Reachable, but it reports no models. Check LLM_MODEL in the repo root .env.`,
    }
  }

  if (!installed.some((id) => sameModel(id, cfg.model))) {
    const sample = `${installed.slice(0, 3).join(', ')}${installed.length > 3 ? '…' : ''}`
    return {
      ...base,
      ok: false,
      detail: local
        ? `Reachable, but "${cfg.model}" isn't installed there. Available: ${sample}. ` +
          `Either \`ollama pull ${cfg.model}\`, or set LLM_MODEL to one of those.`
        : `"${cfg.model}" isn't offered by this provider. Available: ${sample}. ` +
          `Set LLM_MODEL in the repo root .env to a model this provider serves.`,
    }
  }

  return { ...base, ok: true, detail: 'ready' }
}

/** A 401/403 from the provider means a missing or wrong key, not an outage. */
export function describeAuthFailure(cfg: LlmConfig, status: number): HealthReport {
  const base = { baseUrl: cfg.baseUrl, model: cfg.model, ok: false }

  if (!cfg.apiKey) {
    return {
      ...base,
      detail:
        `This provider needs a key and LLM_API_KEY is empty. ` +
        `Free keys: openrouter.ai/keys · console.groq.com/keys · aistudio.google.com/apikey. ` +
        `Put it in the repo root .env.`,
    }
  }

  return {
    ...base,
    detail: `The provider rejected your LLM_API_KEY (HTTP ${status}). Check it hasn't expired.`,
  }
}

/** Model ids out of an OpenAI-compatible /models body, tolerating junk. */
export function parseModelIds(body: unknown): string[] {
  const data = (body as { data?: unknown })?.data
  if (!Array.isArray(data)) return []
  return data
    .map((m) => (m as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
}

export interface CompleteOptions {
  temperature?: number
  maxTokens?: number
  /** Milliseconds before the request is aborted. Defaults to LLM_TIMEOUT_MS, else 4 minutes. */
  timeoutMs?: number
  /** Total attempts for a retryable status. Defaults to 3. */
  retries?: number
}

/** Set LLM_MAX_TOKENS to raise the ceiling for every call. */
function envMaxTokens(): number | undefined {
  const n = Number(process.env.LLM_MAX_TOKENS)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * Generous by default: a big hosted model can legitimately take minutes to
 * write a full page — one measured run took 219s. This exists to break an
 * indefinite hang, not to enforce latency. Routes cap at 300s, so stay under.
 */
function defaultTimeoutMs(): number {
  const configured = Number(process.env.LLM_TIMEOUT_MS)
  return Number.isFinite(configured) && configured > 0 ? configured : 290_000
}

/** What an HTTP status from a model provider actually means to a person. */
function describeStatus(status: number): string {
  if (status === 429) {
    // Not always a rate limit. Google returns 429 with "exceeded your current
    // quota" for a brand-new key on a model that simply has no free
    // allowance — gemini-2.5-pro does this while gemini-2.5-flash answers
    // fine — so the fix is usually "pick a different model", not "wait".
    return (
      'Rate limited, or this model has no free quota on your plan ' +
      '(try a smaller/flash model).'
    )
  }
  if (status === 401 || status === 403) {
    return 'Your provider rejected the API key.'
  }
  if (status === 404) {
    return 'That model does not exist at this endpoint.'
  }
  if (status >= 500) {
    return `The provider is having trouble (HTTP ${status}).`
  }
  return `The provider returned HTTP ${status}.`
}

/**
 * Providers answer errors as JSON, and pasting that JSON at somebody is not
 * an error message. Free-tier daily caps in particular arrive as a wall of
 * nested objects around one useful sentence — pull the sentence out.
 */
function explainBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown } | string
      message?: unknown
    }
    const message =
      typeof parsed.error === 'string'
        ? parsed.error
        : typeof parsed.error?.message === 'string'
          ? parsed.error.message
          : typeof parsed.message === 'string'
            ? parsed.message
            : ''
    if (message) return message
  } catch {
    // Not JSON. Fall through to the raw text.
  }

  const trimmed = body.trim()
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed
}

/** Statuses worth trying again. A 429 on a free tier is a minute, not a wall. */
const RETRYABLE = new Set([429, 500, 502, 503, 504])

/**
 * Some 429s are a minute. Some are tomorrow.
 *
 * Google answers a *daily* cap with `retryDelay: "26s"` and a quotaId of
 * `GenerateRequestsPerDayPerProjectPerModel-FreeTier` — obeying the delay
 * means retrying for minutes against a limit that resets at midnight.
 * Measured: 185 seconds of backoff for a quota of 20 requests per day.
 * OpenRouter says `free-models-per-day`. Neither is worth waiting for.
 */
export function isDailyCap(body: string): boolean {
  return /per-?day|requests per day|RequestsPerDay/i.test(body)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * How long to wait before trying again.
 *
 * Providers say so if you read carefully: an HTTP `Retry-After` header, or —
 * as Google does — a `retryDelay: "26s"` buried in the error body. Guessing
 * when the answer is right there wastes the user's quota window.
 */
/**
 * Per-minute quotas need a per-minute wait.
 *
 * Google answers a 429 with `retryDelay: "5s"`, but its free limit is 10
 * requests per *minute* — so obeying the hint alone just re-enters the same
 * exhausted window and fails again. Measured: an 11-request deck died on
 * slides 6-8 doing exactly that. These floors grow until they clear a full
 * minute, and the hint is only allowed to make the wait longer, never shorter.
 */
const BACKOFF_FLOOR_MS = [8_000, 20_000, 40_000, 60_000]

export function retryDelayMs(
  headerValue: string | null,
  body: string,
  attempt: number,
  status = 429,
): number {
  const floor =
    status === 429
      ? BACKOFF_FLOOR_MS[Math.min(attempt, BACKOFF_FLOOR_MS.length - 1)]
      : Math.min(2_000 * 2 ** attempt, 20_000)

  const header = Number(headerValue)
  if (Number.isFinite(header) && header > 0) {
    return Math.min(Math.max(header * 1000, floor), 90_000)
  }

  const match = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/)
  if (match) {
    return Math.min(Math.max(Number(match[1]) * 1000 + 500, floor), 90_000)
  }

  return floor
}

export async function complete(
  messages: ChatMessage[],
  cfg: LlmConfig,
  opts: CompleteOptions = {},
): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`

  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs()
  const deadline = Date.now() + timeoutMs
  const baseUrl = cfg.baseUrl.replace(/\/+$/, '')
  // Five attempts with the floors above spans about two minutes, which is
  // what a 10-per-minute free tier needs to let an 11-request deck through.
  const maxAttempts = opts.retries ?? 5

  const payload = JSON.stringify({
    model: cfg.model,
    messages,
    stream: false,
    temperature: opts.temperature ?? 0.4,
    // LLM_MAX_TOKENS deliberately overrides the caller: it is the escape
    // hatch offered when a verbose model truncates, and a per-route
    // default it could not beat would make that advice a lie.
    max_tokens: envMaxTokens() ?? opts.maxTokens ?? 4096,
  })

  let res!: Response

  /**
   * Free tiers cap requests per *minute*, and a deck is one request per slide
   * fired back to back — Gemini 2.5 Flash's 10/min limit killed slides 7, 9
   * and 10 of a 10-slide deck. Losing a slide to a limit that clears in
   * seconds is the difference between "free tier works" and "free tier is
   * decoration", so a retryable status waits and tries again.
   */
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(
        `Model at ${baseUrl} timed out after ${timeoutMs}ms. ` +
          `Raise LLM_TIMEOUT_MS, or try a smaller model.`,
      )
    }

    const signal = AbortSignal.timeout(remaining)

    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        signal,
        body: payload,
      })
    } catch (err) {
      if (signal.aborted) {
        throw new Error(
          `Model at ${baseUrl} timed out after ${timeoutMs}ms. ` +
            `A large model on limited memory can be slow — raise LLM_TIMEOUT_MS, ` +
            `or try a smaller model.`,
        )
      }
      throw new Error(
        `Can't reach your model at ${baseUrl}. ` +
          `Is it running? For Ollama: \`ollama serve\`. ` +
          `Check LLM_BASE_URL in the repo root .env. (${(err as Error).message})`,
      )
    }

    if (res.ok) break

    const body = await res.text().catch(() => '')
    const wait = retryDelayMs(
      res.headers?.get?.('retry-after') ?? null,
      body,
      attempt,
      res.status,
    )
    const daily = res.status === 429 && isDailyCap(body)
    const canRetry =
      !daily &&
      attempt < maxAttempts - 1 &&
      RETRYABLE.has(res.status) &&
      Date.now() + wait < deadline

    if (!canRetry) {
      if (daily) {
        throw new Error(
          `Your provider's free daily request limit is used up — this one ` +
            `resets on a schedule, not in a moment, so retrying will not help. ` +
            `Switch provider, run a local model, or come back tomorrow. ` +
            `(${explainBody(body)})`,
        )
      }
      throw new Error(`${describeStatus(res.status)} ${explainBody(body)}`.trim())
    }

    await sleep(wait)
  }

  let data: {
    error?: { message?: string }
    choices?: Array<{ finish_reason?: string; message?: { content?: string } }>
  }

  try {
    data = (await res.json()) as typeof data
  } catch {
    throw new Error(
      `Model at ${baseUrl} returned a response that isn't JSON. ` +
        `Is that an OpenAI-compatible endpoint? Ollama serves one at /v1.`,
    )
  }

  // Providers answer 200 with an error body more often than you'd hope —
  // free-tier rate limits in particular. Without this the caller only sees
  // "unexpected response shape" and has no idea it was throttled.
  if (data.error) {
    throw new Error(
      data.error.message
        ? `Model provider says: ${data.error.message}`
        : `Model provider returned an error: ${JSON.stringify(data.error).slice(0, 200)}`,
    )
  }

  const choice = data.choices?.[0]
  const content = choice?.message?.content

  // Reasoning models spend the token budget thinking before they answer, so
  // hitting the cap can leave the actual answer empty or half-written. Either
  // way the output is unusable, and silently returning it means a broken page.
  if (choice?.finish_reason === 'length') {
    throw new Error(
      `${cfg.model} ran out of room before finishing (finish_reason: length), ` +
        `so the output is cut off. Raise LLM_MAX_TOKENS, or pick a less ` +
        `verbose model — reasoning models burn much of the budget before ` +
        `they start answering.`,
    )
  }

  if (typeof content === 'string' && !content.trim()) {
    throw new Error(
      `${cfg.model} returned an empty response. If it is a reasoning model, ` +
        `the whole token budget may have gone on reasoning. Try another model.`,
    )
  }

  if (typeof content !== 'string') {
    throw new Error(
      `Model returned an unexpected response shape (no choices[0].message.content). ` +
        `Is ${baseUrl} an OpenAI-compatible endpoint?`,
    )
  }

  return content
}
