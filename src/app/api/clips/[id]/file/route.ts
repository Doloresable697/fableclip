import { NextResponse } from 'next/server'
import { join } from 'node:path'
import { getStore } from '@/lib/store'
import { jobPath } from '@/lib/paths'
import { serveFile, slugify } from '@/lib/http'

export const runtime = 'nodejs'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const clip = getStore().getClip(id)

  if (!clip) return NextResponse.json({ error: 'No such clip' }, { status: 404 })
  if (!clip.file) {
    return NextResponse.json(
      { error: 'This clip has not been rendered yet.' },
      { status: 409 },
    )
  }

  // `?download` gets a Content-Disposition and a readable filename; without
  // it the same URL feeds the <video> element in the grid.
  const download = new URL(request.url).searchParams.has('download')

  return serveFile(
    join(jobPath(clip.jobId), clip.file),
    request,
    'video/mp4',
    download ? `${slugify(clip.title)}.mp4` : undefined,
  )
}
