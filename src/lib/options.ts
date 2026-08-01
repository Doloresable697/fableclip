import { DEFAULT_OPTIONS, type JobOptions } from './types'

const REFRAMES = ['crop', 'blur', 'original'] as const
const STYLES = ['punch', 'clean', 'chunky', 'condensed', 'none'] as const
const WHISPER_SIZES = ['tiny', 'base', 'small', 'medium'] as const

const oneOf = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T => (allowed.includes(value as T) ? (value as T) : fallback)

const bounded = (value: unknown, lo: number, hi: number, fallback: number): number => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback
}

/**
 * Everything the browser sends is a suggestion.
 *
 * These bounds are not paranoia about a hostile user — it is your own machine.
 * They are here because `maxSeconds: 99999` is a plausible typo that would put
 * ffmpeg to work for an hour on a clip nobody can post.
 *
 * This lives in lib rather than beside the route that uses it because Next
 * rejects any export from a route file that is not a handler or a route
 * config field, and a validator worth unit-testing has to be importable.
 */
export function normalizeOptions(raw: unknown): JobOptions {
  const body = (raw ?? {}) as Record<string, unknown>

  const minSeconds = bounded(body.minSeconds, 5, 170, DEFAULT_OPTIONS.minSeconds)
  const maxSeconds = bounded(
    body.maxSeconds,
    minSeconds + 5,
    180,
    Math.max(DEFAULT_OPTIONS.maxSeconds, minSeconds + 5),
  )

  return {
    clipCount: bounded(body.clipCount, 1, 20, DEFAULT_OPTIONS.clipCount),
    minSeconds,
    maxSeconds,
    reframe: oneOf(body.reframe, REFRAMES, DEFAULT_OPTIONS.reframe),
    captionStyle: oneOf(body.captionStyle, STYLES, DEFAULT_OPTIONS.captionStyle),
    lang:
      typeof body.lang === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,8})?$/.test(body.lang)
        ? body.lang
        : DEFAULT_OPTIONS.lang,
    whisperModel: oneOf(body.whisperModel, WHISPER_SIZES, DEFAULT_OPTIONS.whisperModel),
  }
}
