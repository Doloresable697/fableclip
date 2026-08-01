import { NextResponse } from 'next/server'
import { join } from 'node:path'
import { getStore } from '@/lib/store'
import { jobPath } from '@/lib/paths'
import { serveFile } from '@/lib/http'

export const runtime = 'nodejs'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const clip = getStore().getClip(id)

  if (!clip) return NextResponse.json({ error: 'No such clip' }, { status: 404 })

  return serveFile(
    join(jobPath(clip.jobId), `clip-${clip.index}.jpg`),
    request,
    'image/jpeg',
  )
}
