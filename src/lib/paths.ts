import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Everything a job produces lives under one directory it can be deleted with. */
export function mediaRoot(): string {
  return process.env.MEDIA_DIR ?? resolve(process.cwd(), 'data', 'media')
}

/** The job's folder, created if it is not there. For anything that writes. */
export function jobDir(jobId: string): string {
  const dir = jobPath(jobId)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * The job's folder, without creating it. For anything that only reads.
 *
 * Serving a file from a deleted job would otherwise recreate its directory on
 * the way to answering 404 — leaving a litter of empty folders behind every
 * stale link.
 */
export function jobPath(jobId: string): string {
  return join(mediaRoot(), safeId(jobId))
}

/**
 * The bundled caption fonts.
 *
 * Handed to libass as `fontsdir` rather than left to fontconfig, so a clip
 * rendered on a Mac and the same clip rendered in the container use the same
 * typeface instead of whatever the host happened to substitute.
 */
export function fontsDir(): string {
  return process.env.FONTS_DIR ?? resolve(process.cwd(), 'assets', 'fonts')
}

/**
 * Job ids come from `randomUUID`, but they arrive back from the network as
 * path segments. Anything that is not a UUID character cannot become one.
 */
export function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new Error(`Refusing to build a path from "${id}"`)
  }
  return id
}
