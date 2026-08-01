import { NextResponse } from 'next/server'
import { cancel } from '@/lib/queue'
import { getStore } from '@/lib/store'

export const runtime = 'nodejs'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const store = getStore()

  const job = store.getJob(id)
  if (!job) return NextResponse.json({ error: 'No such job' }, { status: 404 })

  const stopped = cancel(id)

  // Cancelling something that already finished is not an error worth showing;
  // it means the user clicked as the last stage completed.
  if (!stopped && !['done', 'failed', 'cancelled'].includes(job.stage)) {
    store.patchJob(id, { stage: 'cancelled', detail: 'cancelled' })
  }

  return NextResponse.json({ ok: true, stopped })
}
