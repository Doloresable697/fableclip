import { NextResponse } from 'next/server'
import { resolveLlmConfig } from '@/lib/config'

export const runtime = 'nodejs'

interface RawModel {
  id?: unknown
  name?: unknown
  context_length?: unknown
  pricing?: { prompt?: unknown; completion?: unknown }
  architecture?: { output_modalities?: unknown }
}

/**
 * Providers list everything they host, including music and image models that
 * cannot answer a chat completion at all. Offering those in a model picker is
 * just a way to hand someone a confusing failure, so drop anything that does
 * not declare text output.
 */
const emitsText = (m: RawModel): boolean => {
  const out = m.architecture?.output_modalities
  if (!Array.isArray(out)) return !looksNonChat(m.id)

  // Checking for "text" is not enough: a music model declares
  // ["text", "audio"] and would sail through. Reject any non-text output.
  return (
    out.includes('text') && !out.some((o) => o === 'audio' || o === 'image')
  )
}

/**
 * Providers that publish no modality metadata still list things that cannot
 * answer a chat completion. Google's endpoint returns 59 entries including
 * text-to-speech, embeddings, Imagen and Veo — offering those in a model
 * picker is just a way to hand someone a confusing failure.
 */
const NON_CHAT = /(?:^|[/\-.])(?:tts|embedding|imagen|veo|aqa|learnlm-.*-tts)/i

function looksNonChat(id: unknown): boolean {
  return typeof id === 'string' && NON_CHAT.test(id)
}

export interface ModelOption {
  id: string
  name: string
  context: number
  free: boolean
}

const isFree = (m: RawModel): boolean =>
  Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0

/**
 * The models this provider offers, free ones first.
 *
 * Providers that publish pricing (OpenRouter) let us mark which cost nothing,
 * which is the whole point — a picker that quietly bills you is not a picker
 * for this project. Providers without pricing are returned unmarked.
 */
export async function GET() {
  const cfg = resolveLlmConfig()

  try {
    const res = await fetch(`${cfg.baseUrl}/models`, {
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
      signal: AbortSignal.timeout(8000),
    })

    if (!res.ok) {
      return NextResponse.json({ models: [], current: cfg.model })
    }

    const body = (await res.json()) as { data?: RawModel[] }
    const raw = Array.isArray(body.data) ? body.data : []

    const anyPricing = raw.some((m) => m.pricing !== undefined)

    const models: ModelOption[] = raw
      .filter((m) => typeof m.id === 'string' && m.id)
      .filter(emitsText)
      .map((m) => ({
        id: m.id as string,
        name: typeof m.name === 'string' ? m.name : (m.id as string),
        context: Number(m.context_length) || 0,
        free: anyPricing ? isFree(m) : true,
      }))
      // When the provider publishes pricing, only offer what costs nothing.
      .filter((m) => (anyPricing ? m.free : true))
      .sort((a, b) => b.context - a.context)

    return NextResponse.json({ models, current: cfg.model })
  } catch {
    return NextResponse.json({ models: [], current: cfg.model })
  }
}
