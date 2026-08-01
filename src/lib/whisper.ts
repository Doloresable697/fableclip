import { run, type RunOptions } from './bin'
import { toTranscript } from './captions'
import type { Transcript, Word } from './types'

/**
 * The transcription fallback, for when there are no captions to borrow.
 *
 * Kept as a `python3 -c` string rather than a file on disk so it cannot go
 * missing from a Next standalone build, which copies only what it can trace
 * through imports.
 *
 * `faster-whisper` rather than `openai-whisper`: it is CTranslate2 underneath,
 * needs no PyTorch, and runs several times faster on a CPU — which is the only
 * processor this is going to find in a container.
 *
 * Results stream out one JSON object per line so the caller can report
 * progress. A long video is minutes of silence otherwise.
 */
export const WHISPER_SCRIPT = `
import json, sys

try:
    from faster_whisper import WhisperModel
except ImportError:
    sys.stderr.write("faster-whisper is not installed in this Python.\\n")
    raise SystemExit(3)

audio, size, device, compute, lang = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]

model = WhisperModel(size, device=device, compute_type=compute)
segments, info = model.transcribe(
    audio,
    language=(lang or None),
    word_timestamps=True,
    vad_filter=True,
    condition_on_previous_text=False,
)

print(json.dumps({"event": "info", "lang": info.language, "duration": info.duration}), flush=True)

for seg in segments:
    words = [
        {"t": w.start, "d": max(0.05, w.end - w.start), "text": w.word.strip()}
        for w in (seg.words or [])
        if w.word and w.word.strip()
    ]
    print(json.dumps({"event": "segment", "end": seg.end, "words": words}), flush=True)

print(json.dumps({"event": "done"}), flush=True)
`

export interface WhisperOptions {
  model: string
  lang: string
  device: string
  compute: string
}

export function whisperOptions(model: string, lang: string): WhisperOptions {
  return {
    model: process.env.WHISPER_MODEL || model,
    // "auto-detect" is the honest default when the caller does not know.
    lang: lang === 'auto' ? '' : lang,
    device: process.env.WHISPER_DEVICE || 'cpu',
    // int8 is roughly twice the speed of float32 on a CPU and the word
    // timings are indistinguishable — this is transcription, not mastering.
    compute: process.env.WHISPER_COMPUTE || 'int8',
  }
}

export function whisperArgs(audioPath: string, opts: WhisperOptions): string[] {
  return [
    '-c',
    WHISPER_SCRIPT,
    audioPath,
    opts.model,
    opts.device,
    opts.compute,
    opts.lang,
  ]
}

export type WhisperEvent =
  | { event: 'info'; lang: string; duration: number }
  | { event: 'segment'; end: number; words: Word[] }
  | { event: 'done' }

/** One streamed line into an event, or null for anything that is not one. */
export function parseWhisperLine(line: string): WhisperEvent | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null

  let doc: Record<string, unknown>
  try {
    doc = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return null
  }

  if (doc.event === 'info') {
    return {
      event: 'info',
      lang: typeof doc.lang === 'string' ? doc.lang : '',
      duration: typeof doc.duration === 'number' ? doc.duration : 0,
    }
  }

  if (doc.event === 'segment') {
    const raw = Array.isArray(doc.words) ? doc.words : []
    const words: Word[] = raw
      .map((w) => w as Record<string, unknown>)
      .filter(
        (w) =>
          typeof w.t === 'number' &&
          typeof w.d === 'number' &&
          typeof w.text === 'string' &&
          w.text.trim().length > 0,
      )
      .map((w) => ({
        t: w.t as number,
        d: Math.max(0.05, w.d as number),
        text: (w.text as string).trim(),
      }))

    return {
      event: 'segment',
      end: typeof doc.end === 'number' ? doc.end : 0,
      words,
    }
  }

  if (doc.event === 'done') return { event: 'done' }
  return null
}

export interface TranscribeCallbacks extends RunOptions {
  /** 0–100, from how much of the audio has been consumed. */
  onProgress?: (pct: number) => void
}

export async function transcribe(
  audioPath: string,
  model: string,
  lang: string,
  opts: TranscribeCallbacks = {},
): Promise<Transcript> {
  const options = whisperOptions(model, lang)
  const words: Word[] = []
  let detected = lang
  let duration = 0

  const result = await run('python3', whisperArgs(audioPath, options), {
    ...opts,
    onLine: (line) => {
      const event = parseWhisperLine(line)
      if (!event) return

      if (event.event === 'info') {
        detected = event.lang || detected
        duration = event.duration
        return
      }

      if (event.event === 'segment') {
        words.push(...event.words)
        if (duration > 0 && opts.onProgress) {
          opts.onProgress(Math.min(99, (event.end / duration) * 100))
        }
      }
    },
  })

  if (result.code === 3) {
    throw new Error(
      'faster-whisper is not installed, and this video has no captions to fall ' +
        'back on. The container ships it; running on your own machine needs ' +
        '`pip install faster-whisper`.',
    )
  }

  if (result.code !== 0) {
    throw new Error(
      `Transcription failed (exit ${result.code}). ` +
        `${result.stderr.split('\n').filter(Boolean).slice(-1)[0] ?? ''}`.trim(),
    )
  }

  return toTranscript('whisper', detected, words, true)
}
