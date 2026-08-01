import { NextResponse } from 'next/server'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { getStore } from '@/lib/store'
import { cancel } from '@/lib/queue'
import { mediaRoot, safeId } from '@/lib/paths'

export const runtime = 'nodejs'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const store = getStore()

  const job = store.getJob(id)
  if (!job) return NextResponse.json({ error: 'No such job' }, { status: 404 })

  return NextResponse.json({ job, clips: store.listClips(id) })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const store = getStore()

  if (!store.getJob(id)) {
    return NextResponse.json({ error: 'No such job' }, { status: 404 })
  }

  // Stop the work before deleting what it is writing to, or ffmpeg carries on
  // recreating the directory that was just removed.
  cancel(id)
  store.deleteJob(id)

  // A source video is hundreds of megabytes. Deleting the row and leaving the
  // file behind is how a self-hosted tool quietly fills a disk.
  await rm(join(mediaRoot(), safeId(id)), { recursive: true, force: true }).catch(
    () => undefined,
  )

  return NextResponse.json({ ok: true })
}
