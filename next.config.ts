import type { NextConfig } from 'next'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Next auto-loads `.env` from this directory, which is all a standalone
 * checkout needs. This additionally reads a `.env` one level up, so the folder
 * still works unchanged when it sits inside a monorepo that keeps one shared
 * config for every project. Absent is fine; real environment variables and a
 * local `.env` both win over it.
 */
function loadRootEnv(): void {
  try {
    const text = readFileSync(resolve(process.cwd(), '..', '.env'), 'utf8')

    for (const line of text.split('\n')) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (!match || line.trimStart().startsWith('#')) continue

      const [, key, rawValue] = match
      if (process.env[key] !== undefined) continue

      process.env[key] = rawValue.replace(/^(["'])(.*)\1$/, '$2')
    }
  } catch {
    // No root .env is fine — the defaults in resolveLlmConfig apply.
  }
}

loadRootEnv()

const nextConfig: NextConfig = {
  output: 'standalone',
  /**
   * A stray lockfile in a parent directory makes Next infer the wrong
   * workspace root — here it picked `~/`, three levels up — and a standalone
   * build then traces its dependencies from there. Pinning it to this folder
   * keeps the drop self-contained, which is the rule for every folder in this
   * repo.
   */
  outputFileTracingRoot: import.meta.dirname,
  serverExternalPackages: ['better-sqlite3'],
  devIndicators: false,
  /**
   * `next build` and `next dev` share `.next` by default, so building while
   * the dev server is running corrupts it and the running app starts throwing
   * "Cannot find module './873.js'". `npm run build:check` sets this to a
   * scratch directory so the two can never collide. Docker still uses the
   * default, because it needs `.next/standalone`.
   */
  distDir: process.env.NEXT_DIST_DIR || '.next',
}

export default nextConfig
