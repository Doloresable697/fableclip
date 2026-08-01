import { NextResponse } from 'next/server'
import { getStore } from '@/lib/store'
import { rerenderClip } from '@/lib/pipeline'

export const runtime = 'nodejs'
export const maxDuration = 1800

/**
 * Re-cut one clip, and wait for it.
 *
 * Unlike a whole job this is seconds of work, so it answers with the finished
 * clip rather than a status to poll. An editor that made you refresh to find
 * out whether your change took would not be an editor.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const store = getStore()

  const clip = store.getClip(id)
  if (!clip) return NextResponse.json({ error: 'No such clip' }, { status: 404 })

  const controller = new AbortController()
  // Closing the tab mid-render should stop the render, not leave ffmpeg
  // running against a clip nobody is waiting for.
  request.signal.addEventListener('abort', () => controller.abort(), { once: true })

  try {
    await rerenderClip(clip, controller.signal)
  } catch (err) {
    const message = (err as Error).message
    store.patchClip(id, { status: 'failed', error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }

  return NextResponse.json({ clip: store.getClip(id) })
}
