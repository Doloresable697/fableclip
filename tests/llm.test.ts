import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  resolveBaseUrl,
  complete,
  describeHealth,
  describeAuthFailure,
  isLocalEndpoint,
  parseModelIds,
  retryDelayMs,
  isDailyCap,
} from '@/lib/llm'
import type { LlmConfig } from '@/lib/types'

const cfg: LlmConfig = {
  baseUrl: 'http://localhost:11434/v1',
  model: 'qwen2.5-coder:32b',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(impl: (url: string, init: RequestInit) => unknown) {
  const spy = vi.fn(async (url: string, init: RequestInit) => impl(url, init))
  vi.stubGlobal('fetch', spy)
  return spy
}

function okResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  }
}

describe('resolveBaseUrl', () => {
  it('leaves the URL alone outside Docker', () => {
    expect(resolveBaseUrl('http://localhost:11434/v1', false)).toBe(
      'http://localhost:11434/v1',
    )
  })

  it('rewrites localhost to host.docker.internal inside Docker', () => {
    expect(resolveBaseUrl('http://localhost:11434/v1', true)).toBe(
      'http://host.docker.internal:11434/v1',
    )
  })

  it('rewrites 127.0.0.1 inside Docker', () => {
    expect(resolveBaseUrl('http://127.0.0.1:1234/v1', true)).toBe(
      'http://host.docker.internal:1234/v1',
    )
  })

  it('leaves remote URLs alone inside Docker', () => {
    expect(resolveBaseUrl('https://api.anthropic.com/v1', true)).toBe(
      'https://api.anthropic.com/v1',
    )
  })

  it('strips a trailing slash', () => {
    expect(resolveBaseUrl('http://localhost:11434/v1/', false)).toBe(
      'http://localhost:11434/v1',
    )
  })

  it('rewrites the IPv6 loopback inside Docker', () => {
    expect(resolveBaseUrl('http://[::1]:11434/v1', true)).toBe(
      'http://host.docker.internal:11434/v1',
    )
  })
})

describe('complete', () => {
  it('posts to /chat/completions and returns the message content', async () => {
    const spy = stubFetch(() => okResponse('hello'))
    const out = await complete([{ role: 'user', content: 'hi' }], cfg)

    expect(out).toBe('hello')
    expect(spy).toHaveBeenCalledOnce()

    const [url, init] = spy.mock.calls[0]
    expect(url).toBe('http://localhost:11434/v1/chat/completions')

    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('qwen2.5-coder:32b')
    expect(body.stream).toBe(false)
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('omits the Authorization header when no API key is set', async () => {
    const spy = stubFetch(() => okResponse('x'))
    await complete([{ role: 'user', content: 'hi' }], cfg)

    const headers = spy.mock.calls[0][1].headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
  })

  it('sends the Authorization header when an API key is set', async () => {
    const spy = stubFetch(() => okResponse('x'))
    await complete([{ role: 'user', content: 'hi' }], { ...cfg, apiKey: 'sk-1' })

    const headers = spy.mock.calls[0][1].headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-1')
  })

  it('explains how to fix a refused connection', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed')
    })

    await expect(complete([{ role: 'user', content: 'hi' }], cfg)).rejects.toThrow(
      /Can't reach your model at http:\/\/localhost:11434\/v1/,
    )
  })

  it('names the likely cause and still surfaces the response body', async () => {
    stubFetch(() => ({
      ok: false,
      status: 404,
      text: async () => 'model not found',
    }))

    await expect(complete([{ role: 'user', content: 'hi' }], cfg)).rejects.toThrow(
      /does not exist at this endpoint.*model not found/s,
    )
  })

  it('surfaces a provider error carried in a 200 body', async () => {
    // Free-tier rate limits arrive this way: HTTP 200, no choices, an error.
    stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ error: { message: 'Rate limit exceeded' } }),
    }))

    await expect(complete([{ role: 'user', content: 'hi' }], cfg)).rejects.toThrow(
      /Rate limit exceeded/,
    )
  })

  it('rejects truncated output rather than returning half a page', async () => {
    stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          { finish_reason: 'length', message: { content: '<html><body>half' } },
        ],
      }),
    }))

    await expect(complete([{ role: 'user', content: 'hi' }], cfg)).rejects.toThrow(
      /ran out of room.*finish_reason: length/s,
    )
  })

  it('rejects an empty answer from a reasoning model', async () => {
    stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ finish_reason: 'stop', message: { content: '   ' } }],
      }),
    }))

    await expect(complete([{ role: 'user', content: 'hi' }], cfg)).rejects.toThrow(
      /empty response/i,
    )
  })

  it('errors clearly when the response has no choices', async () => {
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({}) }))

    await expect(complete([{ role: 'user', content: 'hi' }], cfg)).rejects.toThrow(
      /unexpected response/i,
    )
  })

  it('aborts and explains when the model exceeds the timeout', async () => {
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'TimeoutError')),
        )
      }),
    )

    await expect(
      complete([{ role: 'user', content: 'hi' }], cfg, { timeoutMs: 20 }),
    ).rejects.toThrow(/timed out after 20ms/)
  })

  it('passes an abort signal to fetch', async () => {
    const spy = stubFetch(() => okResponse('x'))
    await complete([{ role: 'user', content: 'hi' }], cfg)
    expect(spy.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })

  it('explains a non-JSON response instead of leaking a parser error', async () => {
    stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0')
      },
    }))

    await expect(complete([{ role: 'user', content: 'hi' }], cfg)).rejects.toThrow(
      /isn't JSON.*OpenAI-compatible/s,
    )
  })

  it('does not double the slash when baseUrl has a trailing one', async () => {
    const spy = stubFetch(() => okResponse('x'))
    await complete([{ role: 'user', content: 'hi' }], {
      ...cfg,
      baseUrl: 'http://localhost:11434/v1/',
    })
    expect(spy.mock.calls[0][0]).toBe('http://localhost:11434/v1/chat/completions')
  })
})

describe('parseModelIds', () => {
  it('pulls ids out of an OpenAI-compatible listing', () => {
    expect(
      parseModelIds({ object: 'list', data: [{ id: 'a' }, { id: 'b' }] }),
    ).toEqual(['a', 'b'])
  })

  it('returns nothing for the shape Ollama serves with no models pulled', () => {
    expect(parseModelIds({ object: 'list', data: null })).toEqual([])
  })

  it('tolerates junk without throwing', () => {
    expect(parseModelIds(null)).toEqual([])
    expect(parseModelIds({})).toEqual([])
    expect(parseModelIds({ data: 'nope' })).toEqual([])
    expect(parseModelIds({ data: [{ id: 1 }, {}, { id: 'ok' }] })).toEqual(['ok'])
  })
})

describe('describeHealth', () => {
  it('is ready when the configured model is installed', () => {
    const report = describeHealth(cfg, ['other', 'qwen2.5-coder:32b'])
    expect(report.ok).toBe(true)
    expect(report.detail).toBe('ready')
    expect(report.model).toBe('qwen2.5-coder:32b')
  })

  it('is not ready when the endpoint reports no models at all', () => {
    // Ollama answers /models happily with nothing pulled — a green light
    // here would fail confusingly on the first generation instead.
    const report = describeHealth(cfg, [])
    expect(report.ok).toBe(false)
    expect(report.detail).toMatch(/no models/i)
    expect(report.detail).toContain('ollama pull qwen2.5-coder:32b')
  })

  it('names what is actually available when the model is missing', () => {
    const report = describeHealth(cfg, ['llama3:8b', 'mistral:7b'])
    expect(report.ok).toBe(false)
    expect(report.detail).toContain('llama3:8b')
    expect(report.detail).toContain('mistral:7b')
    expect(report.detail).toMatch(/LLM_MODEL/)
  })

  it('truncates a long model list rather than dumping all of it', () => {
    const report = describeHealth(cfg, [
      'zulu1',
      'zulu2',
      'zulu3',
      'zulu4',
      'zulu5',
    ])
    expect(report.detail).toContain('zulu3')
    expect(report.detail).toContain('…')
    expect(report.detail).not.toContain('zulu4')
    expect(report.detail).not.toContain('zulu5')
  })

  it('always echoes the baseUrl so the user can see what was checked', () => {
    expect(describeHealth(cfg, []).baseUrl).toBe('http://localhost:11434/v1')
  })
})

const cloud: LlmConfig = {
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'cohere/north-mini-code:free',
  apiKey: 'sk-or-test',
}

describe('isLocalEndpoint', () => {
  it('recognises the loopback forms and the docker host alias', () => {
    for (const url of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:1234/v1',
      'http://0.0.0.0:8080/v1',
      'http://[::1]:11434/v1',
      'http://host.docker.internal:11434/v1',
    ]) {
      expect(isLocalEndpoint(url), url).toBe(true)
    }
  })

  it('treats hosted providers as remote', () => {
    expect(isLocalEndpoint('https://openrouter.ai/api/v1')).toBe(false)
    expect(isLocalEndpoint('https://api.groq.com/openai/v1')).toBe(false)
  })

  it('does not throw on a malformed url', () => {
    expect(isLocalEndpoint('not a url')).toBe(false)
  })
})

describe('describeHealth on a hosted provider', () => {
  it('never tells a cloud user to run ollama pull', () => {
    const missing = describeHealth(cloud, ['other/model'])
    expect(missing.ok).toBe(false)
    expect(missing.detail).not.toMatch(/ollama/i)
    expect(missing.detail).toMatch(/LLM_MODEL/)

    const empty = describeHealth(cloud, [])
    expect(empty.detail).not.toMatch(/ollama/i)
  })

  it('is ready when the provider serves the configured model', () => {
    const report = describeHealth(cloud, ['a', 'cohere/north-mini-code:free'])
    expect(report.ok).toBe(true)
    expect(report.detail).toBe('ready')
  })
})

describe('describeAuthFailure', () => {
  it('points at free key signups when no key is set', () => {
    const report = describeAuthFailure({ ...cloud, apiKey: undefined }, 401)
    expect(report.ok).toBe(false)
    expect(report.detail).toMatch(/LLM_API_KEY is empty/)
    expect(report.detail).toContain('openrouter.ai/keys')
  })

  it('says the key was rejected when one is set', () => {
    const report = describeAuthFailure(cloud, 403)
    expect(report.detail).toMatch(/rejected/i)
    expect(report.detail).toContain('403')
    expect(report.detail).not.toMatch(/is empty/)
  })
})

describe('provider error messages', () => {
  const cfg = { baseUrl: 'http://x/v1', model: 'm' }

  /**
   * A daily-cap error used to reach the user as the provider's raw JSON —
   * three levels of nesting around one useful sentence. The sentence is the
   * only part that tells anybody what to do.
   */
  it('pulls the sentence out of a nested provider error body', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            message:
              'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock more',
            code: 429,
            metadata: { headers: { 'X-RateLimit-Remaining': '0' } },
          },
        }),
        { status: 429 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    // A daily cap now short-circuits with its own message rather than
    // suggesting a wait that cannot help.
    await expect(
      complete([{ role: 'user', content: 'hi' }], cfg, { retries: 1 }),
    ).rejects.toThrow(/daily request limit.*free-models-per-day/s)

    vi.unstubAllGlobals()
  })

  it('names the likely cause for each status it can get', async () => {
    for (const [status, expected] of [
      [401, /rejected the API key/i],
      [404, /does not exist at this endpoint/i],
      [503, /having trouble/i],
    ] as const) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('{}', { status })),
      )
      await expect(
        complete([{ role: 'user', content: 'hi' }], cfg, { retries: 1 }),
      ).rejects.toThrow(expected)
      vi.unstubAllGlobals()
    }
  })

  it('truncates a huge non-JSON body instead of pasting it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x'.repeat(5000), { status: 500 })),
    )
    await expect(
      complete([{ role: 'user', content: 'hi' }], cfg, { retries: 1 }),
    ).rejects.toThrow(/…$/)
    vi.unstubAllGlobals()
  })
})

describe('model id forms across providers', () => {
  const google = {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-pro',
  }

  /**
   * Verbatim from a real run: the health check said "gemini-2.5-pro isn't
   * offered by this provider" and then listed models/gemini-2.5-pro among the
   * available ones. Google prefixes ids with "models/" but accepts either
   * form in a request — both were confirmed to complete.
   */
  it('matches a Google id whether or not it carries the models/ prefix', () => {
    const listed = [
      'models/gemini-2.5-flash',
      'models/gemini-2.5-pro',
      'models/gemini-2.0-flash',
    ]
    expect(describeHealth(google, listed).ok).toBe(true)
    expect(
      describeHealth({ ...google, model: 'models/gemini-2.5-pro' }, listed).ok,
    ).toBe(true)
  })

  it('still reports a model the provider genuinely does not serve', () => {
    const report = describeHealth(
      { ...google, model: 'gemini-9-ultra' },
      ['models/gemini-2.5-flash'],
    )
    expect(report.ok).toBe(false)
    expect(report.detail).toContain('gemini-2.5-flash')
  })

  /**
   * Only the literal `models/` prefix is stripped. Comparing last path
   * segments would equate OpenRouter's vendor-scoped ids with unrelated
   * models of the same name.
   */
  it('does not treat a vendor prefix as interchangeable', () => {
    const report = describeHealth(
      { baseUrl: 'https://openrouter.ai/api/v1', model: 'gemma-3-27b' },
      ['google/gemma-3-27b'],
    )
    expect(report.ok).toBe(false)
  })

  it('explains a 429 as possibly no free quota, not only rate limiting', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: { message: 'You exceeded your current quota' },
          }),
          { status: 429 },
        ),
      ),
    )
    await expect(
      complete([{ role: 'user', content: 'hi' }], google, { retries: 1 }),
    ).rejects.toThrow(/no free quota/i)
    vi.unstubAllGlobals()
  })
})

describe('retrying a free-tier rate limit', () => {
  const g: LlmConfig = { baseUrl: 'https://x/v1', model: 'gemini-2.5-flash' }

  const res = (status: number, body: string, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body),
  })

  /**
   * Observed: a 10-slide deck is 11 requests fired back to back, and Gemini
   * 2.5 Flash's free tier allows 10 per minute. Slides 7, 9 and 10 came back
   * empty. The limit clears in seconds, so losing the slide is a choice.
   */
  it('retries a 429 and succeeds', async () => {
    vi.useFakeTimers()
    let calls = 0
    stubFetch(() => {
      calls++
      return calls === 1
        ? res(429, '{"error":{"message":"quota","details":[{"retryDelay":"0.01s"}]}}')
        : res(200, JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
    })

    const pending = complete([{ role: 'user', content: 'hi' }], g)
    // The floor is 8s, so nothing happens sooner than that however short a
    // retryDelay the provider suggested.
    await vi.advanceTimersByTimeAsync(9_000)
    await expect(pending).resolves.toBe('ok')
    expect(calls).toBe(2)
    vi.useRealTimers()
  })

  it('gives up after its attempt budget and reports the real reason', async () => {
    vi.useFakeTimers()
    let calls = 0
    stubFetch(() => {
      calls++
      return res(429, '{"error":{"message":"quota exceeded","details":[{"retryDelay":"0.01s"}]}}')
    })

    const pending = complete([{ role: 'user', content: 'hi' }], g, { retries: 2 })
    const assertion = expect(pending).rejects.toThrow(/quota exceeded/)
    await vi.advanceTimersByTimeAsync(9_000)
    await assertion
    expect(calls).toBe(2)
    vi.useRealTimers()
  })

  it('does not retry a wrong API key', async () => {
    let calls = 0
    stubFetch(() => {
      calls++
      return res(401, '{"error":{"message":"bad key"}}')
    })

    await expect(complete([{ role: 'user', content: 'hi' }], g)).rejects.toThrow(
      /rejected the API key/,
    )
    expect(calls).toBe(1)
  })

  it('does not retry a model that does not exist', async () => {
    let calls = 0
    stubFetch(() => {
      calls++
      return res(404, 'no such model')
    })

    await expect(complete([{ role: 'user', content: 'hi' }], g)).rejects.toThrow()
    expect(calls).toBe(1)
  })

  it('will not sleep past its own deadline', async () => {
    let calls = 0
    stubFetch(() => {
      calls++
      return res(429, '{"error":{"message":"quota"}}')
    })

    // Default backoff is 5s; a 200ms budget leaves no room for even one wait.
    await expect(
      complete([{ role: 'user', content: 'hi' }], g, { timeoutMs: 200 }),
    ).rejects.toThrow()
    expect(calls).toBe(1)
  })
})

describe('retryDelayMs', () => {
  it('prefers the Retry-After header', () => {
    expect(retryDelayMs('12', '', 0)).toBe(12_000)
  })

  it('reads the retryDelay Google buries in the error body', () => {
    expect(retryDelayMs(null, '{"details":[{"retryDelay":"26s"}]}', 0)).toBe(26_500)
  })

  it('backs off far enough to clear a per-minute window', () => {
    expect(retryDelayMs(null, '', 0)).toBe(8_000)
    expect(retryDelayMs(null, '', 1)).toBe(20_000)
    expect(retryDelayMs(null, '', 9)).toBe(60_000)
  })

  /**
   * Google suggests "5s" for a limit that resets over a minute. Obeying it
   * literally re-enters the same exhausted window — measured killing slides
   * 6-8 of an 11-request deck.
   */
  it('will not let a provider hint shorten the wait below the floor', () => {
    expect(retryDelayMs(null, '{"retryDelay":"5s"}', 1)).toBe(20_000)
    expect(retryDelayMs('3', '', 2)).toBe(40_000)
  })

  it('still lets a provider ask for longer', () => {
    expect(retryDelayMs('45', '', 0)).toBe(45_000)
  })

  it('caps the wait', () => {
    expect(retryDelayMs('9999', '', 0)).toBe(90_000)
  })

  it('backs off faster for a server error than a rate limit', () => {
    expect(retryDelayMs(null, '', 0, 503)).toBe(2_000)
  })
})

describe('daily caps versus per-minute limits', () => {
  const g: LlmConfig = { baseUrl: 'https://x/v1', model: 'gemini-2.5-flash' }
  const res = (status: number, body: string) => ({
    ok: false,
    status,
    headers: { get: () => null },
    text: async () => body,
  })

  /**
   * Measured: Google's free tier for gemini-2.5-flash is 20 requests per DAY
   * (quotaId GenerateRequestsPerDayPerProjectPerModel-FreeTier), and it still
   * answers with retryDelay "26s". Obeying that spent 185 seconds backing off
   * against a limit that resets at midnight.
   */
  it('does not retry a Google daily quota, however short the suggested delay', async () => {
    let calls = 0
    stubFetch(() => {
      calls++
      return res(
        429,
        JSON.stringify({
          error: {
            message: 'You exceeded your current quota',
            details: [
              {
                quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
                quotaValue: '20',
                retryDelay: '26s',
              },
            ],
          },
        }),
      )
    })

    await expect(complete([{ role: 'user', content: 'hi' }], g)).rejects.toThrow(
      /daily request limit.*retrying will not help/s,
    )
    expect(calls).toBe(1)
  })

  it('does not retry an OpenRouter daily cap either', async () => {
    let calls = 0
    stubFetch(() => {
      calls++
      return res(429, '{"error":{"message":"Rate limit exceeded: free-models-per-day"}}')
    })

    await expect(complete([{ role: 'user', content: 'hi' }], g)).rejects.toThrow(
      /daily request limit/,
    )
    expect(calls).toBe(1)
  })

  it('still retries a plain per-minute limit', () => {
    expect(isDailyCap('{"error":{"message":"Too many requests, slow down"}}')).toBe(false)
    expect(isDailyCap('{"quotaId":"GenerateRequestsPerMinutePerProject"}')).toBe(false)
  })
})
