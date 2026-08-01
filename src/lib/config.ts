import { getStore } from './store'
import { resolveBaseUrl } from './llm'
import type { LlmConfig } from './types'

export const SETTING_KEYS = ['llm_base_url', 'llm_model', 'llm_api_key'] as const

/**
 * Where the model config comes from, in order of precedence:
 *
 *   1. Settings saved in the app  — so nobody has to edit a file and restart
 *   2. The monorepo root .env     — the shared "one config, every drop" path
 *   3. Built-in defaults
 *
 * Saved settings win because they are the thing the user just clicked Save on;
 * being overruled by a stale .env would be baffling.
 */
export function resolveLlmConfig(): LlmConfig {
  let saved: Record<string, string> = {}
  try {
    saved = getStore().getSettings()
  } catch {
    // No database yet (first run, or a read-only volume). Env still works.
  }

  const baseUrl =
    saved.llm_base_url || process.env.LLM_BASE_URL || 'http://localhost:11434/v1'

  return {
    baseUrl: resolveBaseUrl(baseUrl, process.env.IN_DOCKER === '1'),
    model: saved.llm_model || process.env.LLM_MODEL || 'qwen2.5-coder:7b',
    apiKey: saved.llm_api_key || process.env.LLM_API_KEY || undefined,
  }
}

/** True when the key came from the environment, so the UI can say so. */
export function apiKeyIsFromEnv(): boolean {
  try {
    return !getStore().getSettings().llm_api_key && !!process.env.LLM_API_KEY
  } catch {
    return !!process.env.LLM_API_KEY
  }
}
