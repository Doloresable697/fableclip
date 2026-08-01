import { cpus } from 'node:os'
import { randomUUID } from 'node:crypto'
import { writeFile, readFile, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { runOrThrow } from './bin'
import { buildAss, presetFor } from './ass'
import { analyseFraming, type Framing } from './focus'
import { planCut } from './cut'
import { complete } from './llm'
import { resolveLlmConfig } from './config'
import { jobDir } from './paths'
import { findClipsPrompt } from './prompts'
import {
  audioArgs,
  OUT_HEIGHT,
  OUT_WIDTH,
  probe,
  render,
  stageFonts,
  thumbnailArgs,
  type RenderSpec,
} from './render'
import { scoreClip } from './score'
import { mergeOverlapping, parseClipsResponse, toCandidates } from './select'
import { getStore } from './store'
import { toSegments, toWindows, wordRate, wordsBetween } from './transcript'
import { transcribe } from './whisper'
import type { Clip, Job, Transcript, Word } from './types'
import {
  download,
  fetchInfo,
  findSubtitleFile,
  findVideoFile,
  normalizeUrl,
  parseProgress,
  pickTrack,
  readTranscriptFile,
  type TrackChoice,
} from './ytdlp'

export interface Reporter {
  stage(stage: Job['stage'], detail: string, pct?: number): void
  progress(pct: number, detail?: string): void
}

function reporterFor(jobId: string): Reporter {
  const store = getStore()
  let lastWrite = 0
  let lastDetail = ''

  return {
    stage(stage, detail, pct = 0) {
      lastDetail = detail
      lastWrite = 0
      store.patchJob(jobId, { stage, detail, pct })
    },
    progress(pct, detail) {
      if (detail) lastDetail = detail

      // ffmpeg emits progress several times a second and every write is a
      // disk transaction. The UI polls once a second; anything finer is cost
      // with no visible effect.
      const now = Date.now()
      if (now - lastWrite < 400 && pct < 100) return
      lastWrite = now

      store.patchJob(jobId, { pct: Math.round(pct), detail: lastDetail })
    },
  }
}

/** Where the full transcript lives, so a re-trim need not transcribe again. */
const transcriptPath = (dir: string): string => join(dir, 'transcript.json')

export async function runJob(jobId: string, signal: AbortSignal): Promise<void> {
  const store = getStore()
  const job = store.getJob(jobId)
  if (!job) throw new Error(`Job ${jobId} no longer exists`)

  const report = reporterFor(jobId)
  const dir = jobDir(jobId)

  const source = await fetchSource(job, dir, report, signal)
  const videoPath = source.videoPath
  const transcript = await buildTranscript(job, dir, source, report, signal)

  if (transcript.words.length < 40) {
    throw new Error(
      'There is almost no speech in this video — nothing to clip. ' +
        `Found ${transcript.words.length} words.`,
    )
  }

  await writeFile(transcriptPath(dir), JSON.stringify(transcript), 'utf8')
  store.patchJob(jobId, { transcriptSource: transcript.source })

  const clips = await analyze(job, transcript, report, signal)
  store.putClips(jobId, clips)

  await renderAll(jobId, videoPath, dir, report, signal)

  store.patchJob(jobId, {
    stage: 'done',
    pct: 100,
    detail: `${clips.length} clip${clips.length === 1 ? '' : 's'} ready`,
  })
}

// ─── Stage 1: fetch ──────────────────────────────────────────────────────────

interface FetchedSource {
  videoPath: string
  /** Which caption track was asked for, so the parser knows what it is reading. */
  track: TrackChoice | null
}

async function fetchSource(
  job: Job,
  dir: string,
  report: Reporter,
  signal: AbortSignal,
): Promise<FetchedSource> {
  const store = getStore()

  // An upload is already on disk; there is nothing to fetch.
  if (job.kind === 'upload') {
    const existing = await findVideoFile(dir)
    if (!existing) throw new Error('The uploaded file is missing from disk.')

    report.stage('fetch', 'Reading the upload', 100)
    const info = await probe(existing, { signal })
    store.patchJob(job.id, { duration: info.duration })
    return { videoPath: existing, track: null }
  }

  report.stage('fetch', 'Asking what this video is')
  const url = normalizeUrl(job.url)
  const info = await fetchInfo(url, { signal })

  store.patchJob(job.id, { title: info.title, duration: info.duration })

  const track = pickTrack(info, job.options.lang)
  report.stage(
    'fetch',
    track
      ? `Downloading “${info.title}” with its ${track.kind === 'auto' ? 'machine' : 'uploaded'} captions`
      : `Downloading “${info.title}” — no captions offered, will transcribe`,
  )

  // yt-dlp runs one download pass per stream and each counts to 100%. Taking
  // the highest number seen keeps the bar from sliding backwards when the
  // audio pass starts over at zero.
  let highest = 0
  await download(url, dir, track, {
    signal,
    onLine: (line) => {
      const pct = parseProgress(line)
      if (pct === null) return
      highest = Math.max(highest, pct)
      report.progress(highest)
    },
  })

  const video = await findVideoFile(dir)
  if (!video) {
    throw new Error('yt-dlp finished but produced no video file.')
  }

  return { videoPath: video, track }
}

// ─── Stage 2: transcribe ─────────────────────────────────────────────────────

async function buildTranscript(
  job: Job,
  dir: string,
  source: FetchedSource,
  report: Reporter,
  signal: AbortSignal,
): Promise<Transcript> {
  report.stage('transcribe', 'Looking for captions')

  const subtitle = source.track ? await findSubtitleFile(dir) : null
  if (subtitle && source.track) {
    const parsed = await readTranscriptFile(
      subtitle,
      source.track.kind,
      source.track.lang,
    )

    // Below this the "captions" are a title card and a sign-off, and the run
    // is better served by transcribing properly than by clipping forty words.
    if (parsed.words.length >= 40) {
      report.stage(
        'transcribe',
        `Using the video's own captions — ${parsed.words.length} words, ` +
          `${parsed.wordTimed ? 'word-level timing' : 'line timing'}`,
        100,
      )
      return parsed
    }
  }

  report.stage(
    'transcribe',
    'No usable captions. Transcribing locally — this is the slow part',
  )

  const audio = join(dir, 'audio.wav')
  await runOrThrow('ffmpeg', audioArgs(source.videoPath, audio), { signal })

  const transcript = await transcribe(
    audio,
    job.options.whisperModel,
    job.options.lang,
    {
      signal,
      onProgress: (pct) => report.progress(pct),
    },
  )

  // A 40-minute wav is ~70 MB and nothing reads it again.
  await unlink(audio).catch(() => undefined)

  return transcript
}

// ─── Stage 3: analyze ────────────────────────────────────────────────────────

async function analyze(
  job: Job,
  transcript: Transcript,
  report: Reporter,
  signal: AbortSignal,
): Promise<Clip[]> {
  const segments = toSegments(transcript.words)
  const windows = toWindows(segments)
  const cfg = resolveLlmConfig()

  report.stage(
    'analyze',
    `Reading ${segments.length} lines in ${windows.length} pass${windows.length === 1 ? '' : 'es'}`,
  )

  const perWindow = Math.max(2, Math.ceil(job.options.clipCount / windows.length) + 1)
  const candidates: Array<ReturnType<typeof toCandidates>[number]> = []
  const failures: string[] = []

  for (let i = 0; i < windows.length; i++) {
    if (signal.aborted) throw new Error('Cancelled')

    report.progress((i / windows.length) * 100, `Pass ${i + 1} of ${windows.length}`)

    try {
      const answer = await complete(
        findClipsPrompt(windows[i], job.options, perWindow),
        cfg,
        { temperature: 0.3, maxTokens: 2600 },
      )
      candidates.push(
        ...toCandidates(
          parseClipsResponse(answer),
          segments,
          job.options.minSeconds,
          job.options.maxSeconds,
        ),
      )
    } catch (err) {
      // One window failing is survivable — a rate limit part-way through a
      // long video should cost you that stretch, not the whole run. Every
      // window failing is not, and is reported below.
      failures.push((err as Error).message)
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      failures[0] ??
        'The model found nothing clippable in this video. Try a larger model, ' +
          'or a video with more talking in it.',
    )
  }

  const scored = candidates.map((candidate) => {
    const words = wordsBetween(transcript.words, candidate.start, candidate.end)
    const text = words.map((w) => w.text).join(' ')
    const breakdown = scoreClip(candidate.dimensions, {
      start: candidate.start,
      end: candidate.end,
      text,
      rate: wordRate(transcript.words, candidate.start, candidate.end),
    })

    return { candidate, words, breakdown, score: breakdown.total }
  })

  const survivors = mergeOverlapping(
    scored.map((s) => ({ ...s, start: s.candidate.start, end: s.candidate.end })),
  )
    .sort((a, b) => b.score - a.score)
    .slice(0, job.options.clipCount)

  report.progress(
    100,
    `${survivors.length} clip${survivors.length === 1 ? '' : 's'} chosen from ${candidates.length} candidates`,
  )

  return survivors.map((s, index) => ({
    id: randomUUID(),
    jobId: job.id,
    index,
    start: s.candidate.start,
    end: s.candidate.end,
    title: s.candidate.title,
    hook: s.candidate.hook,
    reason: s.candidate.reason,
    dimensions: s.candidate.dimensions,
    score: s.score,
    breakdown: s.breakdown,
    words: s.words,
    reframe: job.options.reframe,
    focus: 0,
    captionStyle: job.options.captionStyle,
    status: 'pending' as const,
    file: null,
    error: null,
  }))
}

// ─── Stage 4: render ─────────────────────────────────────────────────────────

/**
 * How many clips to cut at once.
 *
 * x264 already threads across cores, so running one clip per core just makes
 * every clip slower. Two or three in flight is the sweet spot: it keeps the
 * encoder busy through the parts of a render that are not encoding — the
 * framing probe, writing the caption file, the thumbnail pass — without the
 * jobs starving each other.
 */
export function renderConcurrency(cores = cpus().length): number {
  const configured = Number(process.env.RENDER_CONCURRENCY)
  if (Number.isFinite(configured) && configured >= 1) return Math.min(8, configured)
  return Math.max(1, Math.min(3, Math.floor(cores / 3)))
}

async function renderAll(
  jobId: string,
  videoPath: string,
  dir: string,
  report: Reporter,
  signal: AbortSignal,
): Promise<void> {
  const store = getStore()
  const clips = store.listClips(jobId)

  report.stage('render', `Cutting ${clips.length} clips`)
  await stageFonts()

  const info = await probe(videoPath, { signal })
  const sourceWords = (await loadTranscript(jobId))?.words ?? null
  const width = renderConcurrency()

  let done = 0
  let next = 0

  const tick = (): void => {
    report.progress(
      (done / clips.length) * 100,
      `Rendered ${done} of ${clips.length}`,
    )
  }

  /**
   * Each worker takes the next clip off the pile. A shared index rather than
   * a fixed slice, because clips differ in length by a factor of three and
   * pre-assigning them leaves one worker finishing alone.
   */
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= clips.length) return
      if (signal.aborted) throw new Error('Cancelled')

      const clip = clips[i]
      try {
        await renderOne(clip, videoPath, dir, info, sourceWords, signal)
      } catch (err) {
        if (signal.aborted) throw err
        // A clip that will not render is one bad card, not a failed job.
        store.patchClip(clip.id, {
          status: 'failed',
          error: (err as Error).message,
        })
      }
      done++
      tick()
    }
  }

  tick()
  await Promise.all(Array.from({ length: Math.min(width, clips.length) }, worker))

  report.progress(100)
}

/**
 * Cut, reframe and caption one clip.
 *
 * Exported because "re-render with a different caption style" is the same
 * operation, and the editor should not be a second implementation of it that
 * drifts out of step.
 */
export async function renderOne(
  clip: Clip,
  videoPath: string,
  dir: string,
  info: { width: number; height: number; hasAudio: boolean },
  /**
   * The whole transcript, on the source timeline.
   *
   * Deliberately not `clip.words`: a rendered clip stores its words on the
   * *output* timeline, with the dead air already taken out. Re-planning a cut
   * from those would compress an already-compressed clip and slide every
   * caption out of sync. Null means the transcript is gone from disk, and the
   * clip is re-cut without splicing rather than wrongly.
   */
  sourceWords: Word[] | null,
  signal: AbortSignal,
  onProgress?: (pct: number) => void,
): Promise<string> {
  const store = getStore()
  store.patchClip(clip.id, { status: 'rendering', error: null })

  const preset = presetFor(clip.captionStyle)
  const captionFile = `clip-${clip.index}.ass`
  const outFile = `clip-${clip.index}.mp4`
  const vertical = clip.reframe !== 'original'

  // Snap to speech and drop the dead air. The words come back on the output
  // timeline, which is what the captions have to be built against — removing
  // two seconds of silence at 0:08 moves every word after it.
  const plan = sourceWords
    ? planCut(sourceWords, clip.start, clip.end)
    : {
        keep: [{ from: clip.start, to: clip.end }],
        words: clip.words,
        duration: Math.max(0.5, clip.end - clip.start),
        removed: 0,
      }

  const framing = await frameFor(clip, videoPath, dir, info, plan.duration, signal)

  if (preset) {
    await writeFile(
      join(dir, captionFile),
      buildAss(plan.words, {
        width: vertical ? OUT_WIDTH : framing.crop.content.w,
        height: vertical ? OUT_HEIGHT : framing.crop.content.h,
        preset,
      }),
      'utf8',
    )
  }

  const origin = plan.keep[0].from

  const spec: RenderSpec = {
    input: basename(videoPath),
    output: outFile,
    start: origin,
    // Read up to the end of the last kept range; `select` discards the rest.
    duration: Math.max(0.5, plan.keep[plan.keep.length - 1].to - origin),
    reframe: clip.reframe,
    focus: clip.focus,
    sourceWidth: info.width,
    sourceHeight: info.height,
    crop: framing.crop,
    keep: plan.keep.map((k) => ({ from: k.from - origin, to: k.to - origin })),
    hasAudio: info.hasAudio,
    captions: preset ? captionFile : null,
    // The render runs with its working directory set to the job folder, so
    // this is `<media>/fonts` without a single character ffmpeg's filter
    // parser could misread.
    fontsDir: '../fonts',
  }

  await render(spec, dir, { signal, onProgress })

  // A poster frame a second in — frame zero of a talking head is often a
  // blink or a mid-word mouth shape.
  await runOrThrow(
    'ffmpeg',
    thumbnailArgs(outFile, `clip-${clip.index}.jpg`, Math.min(1, plan.duration / 4)),
    { cwd: dir, signal },
  ).catch(() => undefined)

  store.patchClip(clip.id, {
    status: 'ready',
    file: outFile,
    error: null,
    words: plan.words,
  })
  return outFile
}

/**
 * Framing for one clip: where the picture is, and where to point the crop.
 *
 * Only measured for a crop — blur fit uses the whole picture, and 16:9 keeps
 * it. A focus the user has moved by hand is honoured rather than re-derived,
 * because overruling somebody's slider on every re-render is not a feature.
 */
async function frameFor(
  clip: Clip,
  videoPath: string,
  dir: string,
  info: { width: number; height: number },
  duration: number,
  signal: AbortSignal,
): Promise<Framing> {
  const framing = await analyseFraming(
    basename(videoPath),
    dir,
    clip.start,
    duration,
    info.width,
    info.height,
    { signal },
  )

  if (clip.reframe !== 'crop' || clip.focus === 0) return framing

  // Somebody moved the slider. Honour it for the whole clip rather than
  // overruling them at every shot change.
  const room = Math.max(0, framing.crop.content.w - framing.crop.w)
  const x = framing.crop.content.x + Math.round((room * (clip.focus + 1)) / 2)

  return {
    crop: {
      ...framing.crop,
      shots: [{ from: 0, x: Math.max(0, Math.floor(x / 2) * 2), y: framing.crop.shots[0].y }],
    },
  }
}

/** Re-cut a clip after the editor changed its trim, reframe or captions. */
export async function rerenderClip(clip: Clip, signal: AbortSignal): Promise<void> {
  const dir = jobDir(clip.jobId)
  const videoPath = await findVideoFile(dir)
  if (!videoPath) {
    throw new Error('The source video for this clip is no longer on disk.')
  }

  // Cheap, and it means a re-render still works if `data/media/fonts` was
  // swept up by someone reclaiming disk.
  await stageFonts()

  const info = await probe(videoPath, { signal })
  const sourceWords = (await loadTranscript(clip.jobId))?.words ?? null
  await renderOne(clip, videoPath, dir, info, sourceWords, signal)
}

/** The stored transcript, for re-deriving a clip's words after a re-trim. */
export async function loadTranscript(jobId: string): Promise<Transcript | null> {
  try {
    const text = await readFile(transcriptPath(jobDir(jobId)), 'utf8')
    return JSON.parse(text) as Transcript
  } catch {
    return null
  }
}
