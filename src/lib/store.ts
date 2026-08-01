import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_OPTIONS } from './types'
import type {
  Clip,
  Job,
  JobOptions,
  JobStage,
  TranscriptSource,
  Word,
} from './types'

export interface NewJob {
  url: string
  title: string
  kind: 'youtube' | 'upload'
  options: JobOptions
}

export interface JobPatch {
  title?: string
  duration?: number
  stage?: JobStage
  pct?: number
  detail?: string
  error?: string | null
  transcriptSource?: TranscriptSource
}

export interface ClipPatch {
  start?: number
  end?: number
  title?: string
  hook?: string
  words?: Word[]
  reframe?: Clip['reframe']
  focus?: number
  captionStyle?: Clip['captionStyle']
  status?: Clip['status']
  file?: string | null
  error?: string | null
  index?: number
  score?: number
  breakdown?: Clip['breakdown']
}

export interface Store {
  createJob(job: NewJob): string
  getJob(id: string): Job | null
  listJobs(): Job[]
  patchJob(id: string, patch: JobPatch): void
  deleteJob(id: string): void
  /** Jobs left mid-flight by a restart, so they can be failed rather than hang. */
  interruptedJobs(): string[]

  putClips(jobId: string, clips: Clip[]): void
  listClips(jobId: string): Clip[]
  getClip(id: string): Clip | null
  patchClip(id: string, patch: ClipPatch): void

  getSettings(): Record<string, string>
  putSettings(values: Record<string, string>): void
}

interface JobRow {
  id: string
  url: string
  title: string
  kind: string
  duration: number
  stage: string
  pct: number
  detail: string
  error: string | null
  options_json: string
  transcript_source: string
  created_at: string
}

interface ClipRow {
  id: string
  job_id: string
  idx: number
  start_s: number
  end_s: number
  title: string
  hook: string
  reason: string
  dimensions_json: string
  score: number
  breakdown_json: string
  words_json: string
  reframe: string
  focus: number
  caption_style: string
  status: string
  file: string | null
  error: string | null
}

const ACTIVE_STAGES = ['queued', 'fetch', 'transcribe', 'analyze', 'render']

export function createStore(path: string): Store {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }

  const db = new Database(path)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id                TEXT PRIMARY KEY,
      url               TEXT NOT NULL,
      title             TEXT NOT NULL DEFAULT '',
      kind              TEXT NOT NULL DEFAULT 'youtube',
      duration          REAL NOT NULL DEFAULT 0,
      stage             TEXT NOT NULL DEFAULT 'queued',
      pct               REAL NOT NULL DEFAULT 0,
      detail            TEXT NOT NULL DEFAULT '',
      error             TEXT,
      options_json      TEXT NOT NULL,
      transcript_source TEXT NOT NULL DEFAULT 'none',
      created_at        TEXT NOT NULL,
      seq               INTEGER
    );
    CREATE TABLE IF NOT EXISTS clips (
      id              TEXT PRIMARY KEY,
      job_id          TEXT NOT NULL REFERENCES jobs(id),
      idx             INTEGER NOT NULL,
      start_s         REAL NOT NULL,
      end_s           REAL NOT NULL,
      title           TEXT NOT NULL,
      hook            TEXT NOT NULL DEFAULT '',
      reason          TEXT NOT NULL DEFAULT '',
      dimensions_json TEXT NOT NULL,
      score           REAL NOT NULL DEFAULT 0,
      breakdown_json  TEXT NOT NULL,
      words_json      TEXT NOT NULL,
      reframe         TEXT NOT NULL DEFAULT 'crop',
      focus           REAL NOT NULL DEFAULT 0,
      caption_style   TEXT NOT NULL DEFAULT 'punch',
      status          TEXT NOT NULL DEFAULT 'pending',
      file            TEXT,
      error           TEXT
    );
    CREATE INDEX IF NOT EXISTS clips_by_job ON clips(job_id, idx);
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  // A monotonic counter, because same-millisecond timestamps do not order and
  // the jobs list has to be stable.
  let counter =
    (db.prepare(`SELECT MAX(seq) AS s FROM jobs`).get() as { s: number | null }).s ?? 0
  const nextSeq = (): number => ++counter

  const parse = <T>(json: string, fallback: T): T => {
    try {
      return JSON.parse(json) as T
    } catch {
      return fallback
    }
  }

  const toJob = (row: JobRow): Job => ({
    id: row.id,
    url: row.url,
    title: row.title,
    kind: row.kind === 'upload' ? 'upload' : 'youtube',
    duration: row.duration,
    stage: row.stage as JobStage,
    pct: row.pct,
    detail: row.detail,
    error: row.error,
    // Merged over the defaults so a job written before an option existed
    // still reads back complete rather than with an undefined field.
    options: { ...DEFAULT_OPTIONS, ...parse<Partial<JobOptions>>(row.options_json, {}) },
    transcriptSource: row.transcript_source as TranscriptSource,
    createdAt: row.created_at,
  })

  const toClip = (row: ClipRow): Clip => ({
    id: row.id,
    jobId: row.job_id,
    index: row.idx,
    start: row.start_s,
    end: row.end_s,
    title: row.title,
    hook: row.hook,
    reason: row.reason,
    dimensions: parse(row.dimensions_json, {
      hook: 5,
      emotion: 5,
      clarity: 5,
      payoff: 5,
      quotability: 5,
      novelty: 5,
    }),
    score: row.score,
    breakdown: parse(row.breakdown_json, { base: 0, modifiers: [], total: row.score }),
    words: parse<Word[]>(row.words_json, []),
    reframe: row.reframe as Clip['reframe'],
    focus: row.focus,
    captionStyle: row.caption_style as Clip['captionStyle'],
    status: row.status as Clip['status'],
    file: row.file,
    error: row.error,
  })

  /**
   * Build an UPDATE from only the fields the caller supplied.
   *
   * Progress is written several times a second from the pipeline; a full-row
   * write would mean every one of those could clobber a field another part of
   * the run had just set.
   */
  function patch(
    table: string,
    id: string,
    columns: Record<string, unknown>,
  ): void {
    const entries = Object.entries(columns).filter(([, v]) => v !== undefined)
    if (entries.length === 0) return

    const assignments = entries.map(([k]) => `${k} = ?`).join(', ')
    db.prepare(`UPDATE ${table} SET ${assignments} WHERE id = ?`).run(
      ...entries.map(([, v]) => (v === null ? null : v)),
      id,
    )
  }

  return {
    createJob(job) {
      const id = randomUUID()
      db.prepare(
        `INSERT INTO jobs (id, url, title, kind, options_json, created_at, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        job.url,
        job.title,
        job.kind,
        JSON.stringify(job.options),
        new Date().toISOString(),
        nextSeq(),
      )
      return id
    },

    getJob(id) {
      const row = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as
        | JobRow
        | undefined
      return row ? toJob(row) : null
    },

    listJobs() {
      return (db.prepare(`SELECT * FROM jobs ORDER BY seq DESC`).all() as JobRow[]).map(
        toJob,
      )
    },

    patchJob(id, p) {
      patch('jobs', id, {
        title: p.title,
        duration: p.duration,
        stage: p.stage,
        pct: p.pct,
        detail: p.detail,
        error: p.error === undefined ? undefined : p.error,
        transcript_source: p.transcriptSource,
      })
    },

    deleteJob(id) {
      const tx = db.transaction((jobId: string) => {
        db.prepare(`DELETE FROM clips WHERE job_id = ?`).run(jobId)
        db.prepare(`DELETE FROM jobs WHERE id = ?`).run(jobId)
      })
      tx(id)
    },

    interruptedJobs() {
      const placeholders = ACTIVE_STAGES.map(() => '?').join(', ')
      return (
        db
          .prepare(`SELECT id FROM jobs WHERE stage IN (${placeholders})`)
          .all(...ACTIVE_STAGES) as Array<{ id: string }>
      ).map((r) => r.id)
    },

    putClips(jobId, clips) {
      const insert = db.prepare(
        `INSERT INTO clips (
           id, job_id, idx, start_s, end_s, title, hook, reason,
           dimensions_json, score, breakdown_json, words_json,
           reframe, focus, caption_style, status, file, error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )

      const tx = db.transaction((rows: Clip[]) => {
        db.prepare(`DELETE FROM clips WHERE job_id = ?`).run(jobId)
        for (const clip of rows) {
          insert.run(
            clip.id,
            jobId,
            clip.index,
            clip.start,
            clip.end,
            clip.title,
            clip.hook,
            clip.reason,
            JSON.stringify(clip.dimensions),
            clip.score,
            JSON.stringify(clip.breakdown),
            JSON.stringify(clip.words),
            clip.reframe,
            clip.focus,
            clip.captionStyle,
            clip.status,
            clip.file,
            clip.error,
          )
        }
      })
      tx(clips)
    },

    listClips(jobId) {
      return (
        db
          .prepare(`SELECT * FROM clips WHERE job_id = ? ORDER BY idx`)
          .all(jobId) as ClipRow[]
      ).map(toClip)
    },

    getClip(id) {
      const row = db.prepare(`SELECT * FROM clips WHERE id = ?`).get(id) as
        | ClipRow
        | undefined
      return row ? toClip(row) : null
    },

    patchClip(id, p) {
      patch('clips', id, {
        start_s: p.start,
        end_s: p.end,
        title: p.title,
        hook: p.hook,
        words_json: p.words === undefined ? undefined : JSON.stringify(p.words),
        reframe: p.reframe,
        focus: p.focus,
        caption_style: p.captionStyle,
        status: p.status,
        file: p.file === undefined ? undefined : p.file,
        error: p.error === undefined ? undefined : p.error,
        idx: p.index,
        score: p.score,
        breakdown_json:
          p.breakdown === undefined ? undefined : JSON.stringify(p.breakdown),
      })
    },

    getSettings() {
      const rows = db.prepare(`SELECT key, value FROM settings`).all() as Array<{
        key: string
        value: string
      }>
      return Object.fromEntries(rows.map((r) => [r.key, r.value]))
    },

    putSettings(values) {
      const upsert = db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      const remove = db.prepare(`DELETE FROM settings WHERE key = ?`)
      const tx = db.transaction((entries: Array<[string, string]>) => {
        for (const [k, v] of entries) {
          // Empty means "fall back to the environment", not "store an empty
          // string" — which would shadow a working .env.
          if (v === '') remove.run(k)
          else upsert.run(k, v)
        }
      })
      tx(Object.entries(values))
    },
  }
}

let singleton: Store | null = null

/** The app-wide store, created lazily so tests can use their own. */
export function getStore(): Store {
  if (!singleton) {
    singleton = createStore(process.env.DB_PATH ?? './data/fableclip.db')
  }
  return singleton
}
