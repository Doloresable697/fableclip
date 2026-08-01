import { NextResponse } from 'next/server'
import { getStore } from '@/lib/store'
import { loadTranscript } from '@/lib/pipeline'
import { scoreClip } from '@/lib/score'
import { wordRate, wordsBetween } from '@/lib/transcript'
import type { CaptionStyle, ReframeMode } from '@/lib/types'

export const runtime = 'nodejs'

const REFRAMES: ReframeMode[] = ['crop', 'blur', 'original']
const STYLES: CaptionStyle[] = ['punch', 'clean', 'chunky', 'condensed', 'none']

/**
 * Edit a clip.
 *
 * Changing the trim is not just two numbers: the burned-in captions are built
 * from the words inside the range, so moving an in-point without re-deriving
 * the words gives a clip whose captions are offset from its own audio. The
 * words come back out of the stored transcript, and the score is recomputed
 * because length and opening line are two of the things it measures.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const store = getStore()

  const clip = store.getClip(id)
  if (!clip) return NextResponse.json({ error: 'No such clip' }, { status: 404 })

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const job = store.getJob(clip.jobId)
  const limit = job?.duration && job.duration > 0 ? job.duration : Number.MAX_SAFE_INTEGER

  const number = (value: unknown, fallback: number): number => {
    const n = Number(value)
    return Number.isFinite(n) ? n : fallback
  }

  let start = Math.max(0, Math.min(limit, number(body.start, clip.start)))
  let end = Math.max(0, Math.min(limit, number(body.end, clip.end)))
  if (end < start) [start, end] = [end, start]
  if (end - start < 1) end = Math.min(limit, start + 1)

  const patch: Parameters<typeof store.patchClip>[1] = {
    start,
    end,
    reframe: REFRAMES.includes(body.reframe as ReframeMode)
      ? (body.reframe as ReframeMode)
      : clip.reframe,
    focus: Math.max(-1, Math.min(1, number(body.focus, clip.focus))),
    captionStyle: STYLES.includes(body.captionStyle as CaptionStyle)
      ? (body.captionStyle as CaptionStyle)
      : clip.captionStyle,
    title:
      typeof body.title === 'string' && body.title.trim()
        ? body.title.trim().slice(0, 160)
        : clip.title,
  }

  const moved = start !== clip.start || end !== clip.end
  if (moved) {
    const transcript = await loadTranscript(clip.jobId)
    if (transcript) {
      const words = wordsBetween(transcript.words, start, end)
      const breakdown = scoreClip(clip.dimensions, {
        start,
        end,
        text: words.map((w) => w.text).join(' '),
        rate: wordRate(transcript.words, start, end),
      })

      patch.words = words
      patch.breakdown = breakdown
      patch.score = breakdown.total
    }
  }

  // The file on disk is now of the old trim, style or crop. Saying "pending"
  // is what stops the card offering a download of something that no longer
  // matches what it describes.
  if (moved || patch.reframe !== clip.reframe || patch.focus !== clip.focus ||
      patch.captionStyle !== clip.captionStyle) {
    patch.status = 'pending'
  }

  store.patchClip(id, patch)
  return NextResponse.json({ clip: store.getClip(id) })
}
