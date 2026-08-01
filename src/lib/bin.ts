import { spawn } from 'node:child_process'

export type Tool = 'ffmpeg' | 'ffprobe' | 'yt-dlp' | 'python3'

const ENV_OVERRIDE: Record<Tool, string> = {
  ffmpeg: 'FFMPEG_BIN',
  ffprobe: 'FFPROBE_BIN',
  'yt-dlp': 'YTDLP_BIN',
  python3: 'PYTHON_BIN',
}

/**
 * What to tell somebody whose machine is missing a tool.
 *
 * "spawn yt-dlp ENOENT" is the error Node gives and it is useless. In the
 * container every one of these is installed, so anybody reading this is
 * running `npm run dev` on their own machine and wants the brew line.
 */
const INSTALL_HINT: Record<Tool, string> = {
  ffmpeg: 'Install it with `brew install ffmpeg`, or run the container instead.',
  ffprobe: 'It ships with ffmpeg — `brew install ffmpeg`.',
  'yt-dlp': 'Install it with `brew install yt-dlp` or `pipx install yt-dlp`.',
  python3: 'Install Python 3, or run the container instead.',
}

export function binaryFor(tool: Tool): string {
  return process.env[ENV_OVERRIDE[tool]] || tool
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface RunOptions {
  /** Called with every line either stream produces, as it arrives. */
  onLine?: (line: string) => void
  /** Aborting kills the child. */
  signal?: AbortSignal
  cwd?: string
  env?: Record<string, string>
  /** Cap on retained output, so a chatty tool cannot exhaust memory. */
  maxBuffer?: number
}

/**
 * Run a tool to completion.
 *
 * Resolves with the exit code rather than throwing on non-zero: ffmpeg and
 * yt-dlp both use exit codes the caller wants to interpret, and the useful
 * part of the message is in stderr either way.
 */
export function run(
  tool: Tool,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const bin = binaryFor(tool)
  const cap = opts.maxBuffer ?? 1_000_000

  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error('Cancelled'))
      return
    }

    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const collect = (
      stream: NodeJS.ReadableStream,
      append: (chunk: string) => void,
    ): void => {
      let pending = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        append(chunk)
        if (!opts.onLine) return

        // ffmpeg reports progress with \r, not \n, so a naive line split
        // never emits anything until the process ends.
        pending += chunk
        const lines = pending.split(/[\r\n]/)
        pending = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim()) opts.onLine(line.trim())
        }
      })
    }

    collect(child.stdout, (c) => {
      stdout = (stdout + c).slice(-cap)
    })
    collect(child.stderr, (c) => {
      stderr = (stderr + c).slice(-cap)
    })

    const onAbort = (): void => {
      child.kill('SIGKILL')
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          err.code === 'ENOENT'
            ? new Error(`\`${bin}\` is not installed. ${INSTALL_HINT[tool]}`)
            : err,
        ),
      )
    })

    child.on('close', (code, signal) => {
      finish(() => {
        if (opts.signal?.aborted) {
          reject(new Error('Cancelled'))
          return
        }
        resolve({ code: code ?? (signal ? 137 : 1), stdout, stderr })
      })
    })
  })
}

/** Run, and throw a readable error if the tool failed. */
export async function runOrThrow(
  tool: Tool,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const result = await run(tool, args, opts)
  if (result.code !== 0) {
    throw new Error(`${tool} failed (exit ${result.code}): ${lastMeaningfulLine(result.stderr)}`)
  }
  return result
}

/**
 * The line worth showing from a tool's stderr.
 *
 * ffmpeg prints its whole build configuration before it prints the reason it
 * failed, and yt-dlp interleaves warnings with progress. The last non-progress
 * line is nearly always the actual complaint.
 */
export function lastMeaningfulLine(stderr: string): string {
  const lines = stderr
    .split(/[\r\n]/)
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 0 &&
        !/^\s*(frame|size)=/.test(l) &&
        !/^\[download\]/.test(l) &&
        !/^\s*(configuration|built with|lib[a-z]+\s+\d)/.test(l),
    )

  const error = [...lines].reverse().find((l) => /error|failed|unable|invalid/i.test(l))
  return (error ?? lines[lines.length - 1] ?? 'no output').slice(0, 400)
}
