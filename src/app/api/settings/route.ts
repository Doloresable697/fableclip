import { NextResponse } from 'next/server'
import { getStore } from '@/lib/store'
import { apiKeyIsFromEnv, resolveLlmConfig } from '@/lib/config'
import { probeConfig } from '@/lib/probe'

export const runtime = 'nodejs'

/**
 * The saved key is never sent back to the browser — only whether one exists.
 * It is the user's own credential on their own machine, but echoing it into
 * every page load is a habit worth not having.
 */
export async function GET() {
  const cfg = resolveLlmConfig()

  return NextResponse.json({
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    hasKey: !!cfg.apiKey,
    keyFromEnv: apiKeyIsFromEnv(),
  })
}

export async function PUT(request: Request) {
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

  const baseUrl = str(body.baseUrl)
  if (baseUrl) {
    try {
      new URL(baseUrl)
    } catch {
      return NextResponse.json(
        { error: `"${baseUrl}" is not a valid URL.` },
        { status: 400 },
      )
    }
  }

  const values: Record<string, string> = {
    llm_base_url: baseUrl,
    llm_model: str(body.model),
  }

  // Absent means "leave it alone"; empty string means "clear it".
  if ('apiKey' in body) values.llm_api_key = str(body.apiKey)

  try {
    getStore().putSettings(values)
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }

  // Verify before reporting success. Saving a provider you have no key for
  // used to look identical to saving a working one — the app looked
  // configured and only failed later, when Build was pressed.
  const cfg = resolveLlmConfig()
  // Deep probe: listing a model does not mean the key may use it. Google
  // lists gemini-2.5-pro for everyone and 429s free keys on first use.
  const health = await probeConfig(cfg, 15_000, true)

  return NextResponse.json({
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    hasKey: !!cfg.apiKey,
    keyFromEnv: apiKeyIsFromEnv(),
    ok: health.ok,
    detail: health.detail,
  })
}
