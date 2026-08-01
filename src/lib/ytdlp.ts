import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { run, runOrThrow, type RunOptions } from './bin'
import { parseJson3, parseVtt, toTranscript } from './captions'
import type { Transcript } from './types'

export interface SourceInfo {
  id: string
  title: string
  duration: number
  /** Languages with a machine-generated caption track. */
  autoLangs: string[]
  /** Languages with a creator-uploaded caption track. */
  manualLangs: string[]
}

export interface TrackChoice {
  lang: string
  kind: 'auto' | 'manual'
}

/**
 * Reject anything that is not a web URL.
 *
 * Nothing here is passed through a shell, so this is not about injection. It
 * is about a leading `-` being read by yt-dlp as an option, and about `file://`
 * turning "paste a link" into "read a path on the server".
 */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim()

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`"${trimmed.slice(0, 80)}" is not a URL.`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http and https links work here, not ${url.protocol}`)
  }

  return url.toString()
}

/**
 * Ask what the video is without downloading it.
 *
 * `skip=translated_subs` matters more than it looks: without it YouTube lists
 * every caption track machine-translated into roughly 200 languages, which is
 * megabytes of JSON to parse and — worse — makes it hard to tell the video's
 * own track apart from a translation of it.
 */
export function infoArgs(url: string, jsRuntime = ''): string[] {
  return [
    '--dump-single-json',
    '--no-playlist',
    '--no-warnings',
    ...runtimeArgs(jsRuntime),
    '--extractor-args',
    'youtube:skip=translated_subs',
    url,
  ]
}

/**
 * YouTube now expects the extractor to be able to run its player JavaScript,
 * and yt-dlp warns that going without "has been deprecated, and some formats
 * may be missing". It looks for `deno` by default and finds nothing.
 *
 * This image is built on `node:22-slim`, so a perfectly good runtime is
 * already sitting on the PATH — it only has to be named. Passed as a value
 * rather than hard-coded because the flag is recent, and a version of yt-dlp
 * that has never heard of it must not be handed it (see `jsRuntime`).
 */
function runtimeArgs(jsRuntime: string): string[] {
  return jsRuntime ? ['--js-runtimes', jsRuntime] : []
}

let cachedRuntime: string | null = null

/** Whether this yt-dlp understands `--js-runtimes`, asked once and remembered. */
export async function jsRuntime(opts: RunOptions = {}): Promise<string> {
  if (cachedRuntime !== null) return cachedRuntime

  cachedRuntime = ''
  try {
    const help = await run('yt-dlp', ['--help'], { ...opts, maxBuffer: 400_000 })
    if (help.code === 0 && help.stdout.includes('--js-runtimes')) {
      cachedRuntime = 'node'
    }
  } catch {
    // yt-dlp missing entirely is reported properly by the first real call.
  }

  return cachedRuntime
}

export function parseInfo(json: string): SourceInfo {
  let doc: Record<string, unknown>
  try {
    doc = JSON.parse(json) as Record<string, unknown>
  } catch {
    throw new Error('yt-dlp returned something that is not JSON. Is it up to date?')
  }

  const langsWithJson = (value: unknown): string[] => {
    if (!value || typeof value !== 'object') return []
    return Object.keys(value as Record<string, unknown>)
  }

  return {
    id: typeof doc.id === 'string' ? doc.id : '',
    title: typeof doc.title === 'string' ? doc.title : 'Untitled',
    duration: typeof doc.duration === 'number' ? doc.duration : 0,
    autoLangs: langsWithJson(doc.automatic_captions),
    manualLangs: langsWithJson(doc.subtitles),
  }
}

/**
 * Which caption track to ask for.
 *
 * Machine-generated wins over creator-uploaded, which is the opposite of what
 * you would guess. The uploaded track has better text, but it is one blob per
 * line with no word timings; the machine track carries a per-word offset for
 * every word it heard. Word timing is what makes the caption highlight land on
 * the word being spoken, and it cannot be recovered from a line.
 *
 * A track named `<lang>-orig` is the video's own language, offered when the
 * default track is a translation. It beats the plain code.
 */
export function pickTrack(info: SourceInfo, preferred: string): TrackChoice | null {
  const orig = (list: string[]): string | undefined =>
    list.find((l) => l === `${preferred}-orig`) ??
    list.find((l) => l === preferred) ??
    list.find((l) => l.startsWith(`${preferred}-`)) ??
    // The video may simply not be in the requested language. An original
    // track in the language actually spoken beats nothing at all.
    list.find((l) => l.endsWith('-orig')) ??
    list[0]

  const auto = orig(info.autoLangs)
  if (auto) return { lang: auto, kind: 'auto' }

  const manual = orig(info.manualLangs)
  if (manual) return { lang: manual, kind: 'manual' }

  return null
}

/**
 * Download the video, and the chosen caption track alongside it.
 *
 * The format string prefers H.264 video with AAC audio at or below 1080p: it
 * is what every phone plays, and it lets ffmpeg do less work later. The
 * fallbacks step down to "whatever this site has" rather than failing, because
 * a VP9-only source is still a source.
 */
export function downloadArgs(
  url: string,
  dir: string,
  track: TrackChoice | null,
  maxHeight = 1080,
  jsRuntimeName = '',
): string[] {
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--newline',
    ...runtimeArgs(jsRuntimeName),
    '--extractor-args',
    'youtube:skip=translated_subs',
    '-f',
    `bv*[height<=${maxHeight}][vcodec^=avc1]+ba[acodec^=mp4a]/` +
      `bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]/b`,
    '--merge-output-format',
    'mp4',
    '-o',
    join(dir, 'source.%(ext)s'),
  ]

  if (track) {
    args.push(
      track.kind === 'auto' ? '--write-auto-subs' : '--write-subs',
      '--sub-langs',
      track.lang,
      '--sub-format',
      'json3/vtt/best',
    )
  }

  args.push(url)
  return args
}

/**
 * How far along a `[download] 12.3% of 41.20MiB` line is.
 *
 * Returns null for every other line, including the second `[download]` pass
 * yt-dlp runs for the audio stream — the caller decides what two passes to
 * 100% should mean.
 */
export function parseProgress(line: string): number | null {
  const match = line.match(/\[download\]\s+(\d{1,3}(?:\.\d+)?)%/)
  if (!match) return null

  const pct = Number(match[1])
  return Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : null
}

/** The caption file yt-dlp wrote, whatever it decided to call it. */
export async function findSubtitleFile(dir: string): Promise<string | null> {
  const files = await readdir(dir).catch(() => [] as string[])

  const json3 = files.find((f) => f.startsWith('source.') && f.endsWith('.json3'))
  if (json3) return join(dir, json3)

  const vtt = files.find((f) => f.startsWith('source.') && f.endsWith('.vtt'))
  return vtt ? join(dir, vtt) : null
}

export async function readTranscriptFile(
  path: string,
  kind: 'auto' | 'manual',
  lang: string,
): Promise<Transcript> {
  const text = await readFile(path, 'utf8')
  const source = kind === 'auto' ? 'youtube-auto' : 'youtube-manual'

  if (path.endsWith('.json3')) {
    const { words, wordTimed } = parseJson3(text)
    return toTranscript(source, lang, words, wordTimed)
  }

  return toTranscript(source, lang, parseVtt(text), false)
}

export async function fetchInfo(url: string, opts: RunOptions = {}): Promise<SourceInfo> {
  // yt-dlp's metadata dump for a YouTube video is a few megabytes even with
  // the translations skipped, and `run` keeps only the tail of what exceeds
  // its cap — which would leave unparseable JSON.
  const result = await run('yt-dlp', infoArgs(url, await jsRuntime(opts)), {
    ...opts,
    maxBuffer: 64_000_000,
  })

  if (result.code !== 0) throw new Error(explainYtdlp(result.stderr))
  return parseInfo(result.stdout)
}

/**
 * What a yt-dlp failure actually means to the person who pasted a link.
 *
 * Pasting `ERROR: unable to download video data: HTTP Error 403: Forbidden` at
 * somebody tells them nothing about what to do next — and that particular one
 * is usually temporary, which is the single most useful thing to know about it.
 */
export function explainYtdlp(stderr: string): string {
  const text = stderr.replace(/\s+/g, ' ')

  if (/HTTP Error 403|Forbidden/i.test(text)) {
    return (
      'YouTube refused the download (HTTP 403). This is usually temporary — ' +
      'it throttles bursts of requests from one address. Wait a minute and ' +
      'try again; if it keeps happening, update yt-dlp.'
    )
  }
  if (/HTTP Error 429|Too Many Requests/i.test(text)) {
    return 'YouTube is rate limiting this machine (HTTP 429). Give it a few minutes.'
  }
  if (/Private video|members-only|Join this channel/i.test(text)) {
    return 'That video is private or members-only, so there is nothing to download.'
  }
  if (/Video unavailable|has been removed|no longer available/i.test(text)) {
    return 'That video is unavailable — removed, or blocked in this region.'
  }
  if (/age.?restricted|confirm your age|Sign in to confirm/i.test(text)) {
    return (
      'That video is age-restricted, so it cannot be fetched without signing ' +
      'in. fableclip does not take your YouTube credentials.'
    )
  }
  if (/is not a valid URL|Unsupported URL/i.test(text)) {
    return 'yt-dlp does not know how to read that link.'
  }

  const line =
    text
      .split('ERROR:')
      .slice(1)
      .join('ERROR:')
      .trim() || text.trim()
  return `Download failed: ${line.slice(0, 300) || 'unknown error'}`
}

export async function download(
  url: string,
  dir: string,
  track: TrackChoice | null,
  opts: RunOptions = {},
): Promise<void> {
  const result = await run(
    'yt-dlp',
    downloadArgs(url, dir, track, 1080, await jsRuntime(opts)),
    opts,
  )

  // A missing caption track is a warning, not a failure — the video is what
  // matters and Whisper can cover the rest. yt-dlp still exits non-zero for
  // it, so a plain exit-code check would throw away a perfectly good download.
  if (result.code !== 0) {
    const fatal = !/subtitle/i.test(result.stderr) || !(await hasVideo(dir))
    if (fatal) throw new Error(explainYtdlp(result.stderr))
  }
}

async function hasVideo(dir: string): Promise<boolean> {
  const files = await readdir(dir).catch(() => [] as string[])
  return files.some((f) => /^source\.(mp4|mkv|webm|mov)$/.test(f))
}

/** The downloaded video file, whatever container it ended up in. */
export async function findVideoFile(dir: string): Promise<string | null> {
  const files = await readdir(dir).catch(() => [] as string[])
  const video = files.find((f) => /^source\.(mp4|mkv|webm|mov)$/.test(f))
  return video ? join(dir, video) : null
}
