import { NextResponse } from 'next/server'
import { join } from 'node:path'
import { unlink } from 'node:fs/promises'
import { getStore } from '@/lib/store'
import { enqueue } from '@/lib/queue'
import { jobDir } from '@/lib/paths'
import { streamToFile } from '@/lib/http'
import { normalizeOptions } from '@/lib/options'

export const runtime = 'nodejs'
// A source video is measured in gigabytes; nothing here may be buffered.
export const maxDuration = 3600

const EXTENSIONS = ['mp4', 'mkv', 'webm', 'mov'] as const

/**
 * Uploads arrive as a raw body, not multipart.
 *
 * `request.formData()` reads the whole request into memory before handing it
 * over, which for a two-hour recording means several gigabytes of RSS and an
 * out-of-memory kill. A raw body streams to disk a chunk at a time and needs
 * no parser at all — the two fields that would have been form fields ride
 * along as headers instead.
 */
export async function POST(request: Request) {
  const name = request.headers.get('x-filename') ?? 'upload.mp4'
  const extension = (name.split('.').pop() ?? '').toLowerCase()

  if (!EXTENSIONS.includes(extension as (typeof EXTENSIONS)[number])) {
    return NextResponse.json(
      {
        error:
          `fableclip reads ${EXTENSIONS.join(', ')}. ` +
          `"${name.slice(0, 60)}" is not one of those — convert it first, or paste a link.`,
      },
      { status: 400 },
    )
  }

  let options: unknown = {}
  try {
    options = JSON.parse(request.headers.get('x-options') ?? '{}')
  } catch {
    // Header was mangled; the defaults are fine.
  }

  const store = getStore()
  const id = store.createJob({
    url: name,
    title: name.replace(/\.[^.]+$/, ''),
    kind: 'upload',
    options: normalizeOptions(options),
  })

  const target = join(jobDir(id), `source.${extension}`)

  try {
    await streamToFile(request.body, target)
  } catch (err) {
    await unlink(target).catch(() => undefined)
    store.deleteJob(id)
    return NextResponse.json(
      { error: `Upload failed: ${(err as Error).message}` },
      { status: 400 },
    )
  }

  enqueue(id)
  return NextResponse.json({ id }, { status: 201 })
}
