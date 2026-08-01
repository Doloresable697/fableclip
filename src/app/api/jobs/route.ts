import { NextResponse } from 'next/server'
import { getStore } from '@/lib/store'
import { enqueue, sweepInterrupted } from '@/lib/queue'
import { normalizeOptions } from '@/lib/options'
import { normalizeUrl } from '@/lib/ytdlp'

export const runtime = 'nodejs'

export async function GET() {
  // The list is where a job stranded by a restart is noticed, so it is also
  // where the stranding gets recorded. Without this, nothing marks those jobs
  // until somebody happens to start a new one.
  sweepInterrupted()
  return NextResponse.json({ jobs: getStore().listJobs() })
}

export async function POST(request: Request) {
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  let url: string
  try {
    url = normalizeUrl(String(body.url ?? ''))
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }

  const id = getStore().createJob({
    url,
    // Replaced with the real title the moment yt-dlp reports one.
    title: url.replace(/^https?:\/\//, '').slice(0, 90),
    kind: 'youtube',
    options: normalizeOptions(body.options),
  })

  enqueue(id)
  return NextResponse.json({ id }, { status: 201 })
}
