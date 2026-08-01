/** Shared with every other Slopsource drop — the "one config" contract. */
export interface LlmConfig {
  baseUrl: string
  model: string
  apiKey?: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

// ─── Transcript ──────────────────────────────────────────────────────────────

/**
 * One spoken word, in seconds from the start of the source video.
 *
 * Seconds rather than milliseconds because every consumer — ffmpeg's `-ss`,
 * ASS timestamps, the HTML player — wants seconds, and converting in four
 * places is four chances to be off by a thousand.
 */
export interface Word {
  /** Start time, seconds. */
  t: number
  /** Duration, seconds. May be an estimate when the source lacks word timing. */
  d: number
  text: string
}

/** A sentence-ish run of words. The unit the model reasons about. */
export interface Segment {
  start: number
  end: number
  text: string
  words: Word[]
}

export type TranscriptSource =
  | 'youtube-auto'
  | 'youtube-manual'
  | 'whisper'
  | 'none'

export interface Transcript {
  source: TranscriptSource
  lang: string
  words: Word[]
  /** True when the source gave real per-word times rather than interpolated ones. */
  wordTimed: boolean
}

// ─── Clips ───────────────────────────────────────────────────────────────────

/** How the 16:9 source becomes a 9:16 clip. */
export type ReframeMode = 'crop' | 'blur' | 'original'

export type CaptionStyle = 'punch' | 'clean' | 'chunky' | 'condensed' | 'none'

/**
 * The six things a model can actually judge about a passage of speech, each
 * 0–10. Deliberately not "virality" as one number: asking for a single score
 * gets you a 7 every time.
 */
export interface Dimensions {
  /** Does the first sentence make you stay? */
  hook: number
  /** Does it carry feeling — surprise, anger, delight, tension? */
  emotion: number
  /** Can a stranger follow it with no other context? */
  clarity: number
  /** Does it land somewhere, or just stop? */
  payoff: number
  /** Is there a line somebody would screenshot? */
  quotability: number
  /** Is the claim non-obvious? */
  novelty: number
}

export interface ScoreModifier {
  label: string
  delta: number
  detail: string
}

export interface ScoreBreakdown {
  /** 0–100 from the weighted dimensions alone. */
  base: number
  modifiers: ScoreModifier[]
  /** 0–100 after modifiers, clamped. */
  total: number
}

/** What the model is asked to return, before any of it is trusted. */
export interface ClipCandidate {
  startQuote: string
  endQuote: string
  title: string
  hook: string
  reason: string
  dimensions: Dimensions
}

export type ClipStatus = 'pending' | 'rendering' | 'ready' | 'failed'

export interface Clip {
  id: string
  jobId: string
  /** Position in the ranked list, 0-based. Recomputed whenever scores change. */
  index: number
  start: number
  end: number
  title: string
  hook: string
  reason: string
  dimensions: Dimensions
  score: number
  breakdown: ScoreBreakdown
  /** The words inside [start, end], re-based so the clip starts at 0. */
  words: Word[]
  reframe: ReframeMode
  /** Horizontal focus for `crop`, −1 (hard left) to 1 (hard right). */
  focus: number
  captionStyle: CaptionStyle
  status: ClipStatus
  /** Filename inside the job's media directory, once rendered. */
  file: string | null
  error: string | null
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

export type JobStage =
  | 'queued'
  | 'fetch'
  | 'transcribe'
  | 'analyze'
  | 'render'
  | 'done'
  | 'failed'
  | 'cancelled'

export const STAGES: JobStage[] = [
  'queued',
  'fetch',
  'transcribe',
  'analyze',
  'render',
  'done',
]

export interface JobOptions {
  /** How many clips to keep. The model is asked for more and the best survive. */
  clipCount: number
  minSeconds: number
  maxSeconds: number
  reframe: ReframeMode
  captionStyle: CaptionStyle
  /** Caption/transcript language hint, e.g. `en`. */
  lang: string
  /** faster-whisper model size, used only when no captions exist. */
  whisperModel: string
}

export const DEFAULT_OPTIONS: JobOptions = {
  clipCount: 6,
  minSeconds: 20,
  maxSeconds: 60,
  reframe: 'crop',
  captionStyle: 'punch',
  lang: 'en',
  whisperModel: 'base',
}

export interface Job {
  id: string
  /** The YouTube URL, or the original filename for an upload. */
  url: string
  title: string
  kind: 'youtube' | 'upload'
  /** Source duration in seconds, once known. */
  duration: number
  stage: JobStage
  /** 0–100 within the current stage. */
  pct: number
  detail: string
  error: string | null
  options: JobOptions
  transcriptSource: TranscriptSource
  createdAt: string
}
