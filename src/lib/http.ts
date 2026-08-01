import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

/**
 * Serve a file, honouring Range requests.
 *
 * Not optional for video: without a 206 response Safari refuses to play the
 * file at all, and Chrome downloads the whole clip before it will let you
 * scrub. Both look like "the render is broken" and neither is.
 */
export async function serveFile(
  path: string,
  request: Request,
  contentType: string,
  filename?: string,
): Promise<Response> {
  let size: number
  try {
    size = (await stat(path)).size
  } catch {
    return new Response('Not found', { status: 404 })
  }

  const headers = new Headers({
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    // Everything here is generated locally and re-rendered in place, so a
    // cached copy would show yesterday's captions after an edit.
    'Cache-Control': 'no-store',
  })

  if (filename) {
    headers.set('Content-Disposition', `attachment; filename="${sanitize(filename)}"`)
  }

  const range = request.headers.get('range')
  const match = range?.match(/^bytes=(\d*)-(\d*)$/)

  if (match) {
    const start = match[1] ? Number(match[1]) : 0
    const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1

    if (Number.isNaN(start) || start >= size || end < start) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` },
      })
    }

    headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
    headers.set('Content-Length', String(end - start + 1))

    return new Response(toWebStream(createReadStream(path, { start, end })), {
      status: 206,
      headers,
    })
  }

  headers.set('Content-Length', String(size))
  return new Response(toWebStream(createReadStream(path)), { status: 200, headers })
}

function toWebStream(stream: NodeJS.ReadableStream): ReadableStream {
  return Readable.toWeb(stream as Readable) as unknown as ReadableStream
}

/** A filename that cannot break out of the Content-Disposition header. */
export function sanitize(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f"\\/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned || 'clip').slice(0, 120)
}

/** Turn a title into something safe to hand a filesystem. */
export function slugify(text: string, fallback = 'clip'): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || fallback
}

/** Stream a request body straight to disk, never holding it in memory. */
export async function streamToFile(
  body: ReadableStream | null,
  path: string,
): Promise<void> {
  if (!body) throw new Error('No file was sent.')

  const { createWriteStream } = await import('node:fs')
  const { pipeline } = await import('node:stream/promises')

  await pipeline(
    Readable.fromWeb(body as unknown as WebReadableStream),
    createWriteStream(path),
  )
}
