/**
 * Module-scope background-job machinery shared by the MCP tools whose work
 * can outlast an MCP caller's request timeout (~60 s): `branch_gc`,
 * `worktree_gc`, `session_wrapup_plan`.
 *
 * Each tool owns one registry, created at MODULE scope: the daemon builds a
 * NEW McpServer per MCP connection and calls `registerSessionTools` on each,
 * so a registry created inside that function would be invisible to a
 * `*_status` poll arriving on another connection. A finished job's result is
 * also written to `<dir>/<id>.json`, so a poll survives eviction from the
 * map and a daemon restart; finished jobs older than 1 h are dropped (map
 * entry + file) when a new job starts, and the directory itself is swept for
 * stale files on every start (a restarted daemon's empty map never evicts a
 * pre-restart file by id).
 *
 * NOTE: every finished run — including an ordinary blocking call — allocates
 * a job entry and writes its result to disk, even though the caller never
 * sees a `jobId`.
 */

import { randomBytes } from "node:crypto"
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

const JOB_RETENTION_MS = 3_600_000
export const JOB_POLL_AFTER_MS = 30_000

export interface BackgroundJob<T> {
  id: string
  status: "running" | "done" | "failed"
  startedAt: string
  startedMs: number
  endedAt?: string
  result?: T
  /** Set only once the result file was actually written (the write is
   *  best-effort). The sole source of a `resultPath` a view may announce:
   *  while a job runs — or when the write failed — no such file exists. */
  resultPath?: string
  error?: string
}

export interface BackgroundJobRegistry<T> {
  /** Point the registry at another jobs dir (tests). Last write wins. */
  setDir(dir: string): void
  dir(): string
  resultPathFor(id: string): string
  get(id: string): BackgroundJob<T> | undefined
  /** Register + start `run`; the returned promise is the run itself. */
  start(run: () => Promise<T>): { job: BackgroundJob<T>; promise: Promise<T> }
  /** Read a finished job's result file. Only a well-formed id may touch the
   *  filesystem, so a crafted id like `../x` can never escape the jobs dir.
   *  `undefined` when the id is malformed or the file is missing. */
  readResultFile(id: string): Promise<T | undefined>
  /** The fire-and-drop payload for `wait: false` / a `waitMs` timeout. Carries
   *  no `resultPath`: the result file only exists once the job is done, and
   *  the done view announces it. */
  backgroundView(job: BackgroundJob<T>, followUp: { tool: string; hint: string }): object
  /** The `*_status` view for a still-running or failed job. */
  progressView(job: BackgroundJob<T>): object
}

export function createBackgroundJobRegistry<T>(opts: { idPrefix: string; defaultDir: string }): BackgroundJobRegistry<T> {
  const jobs = new Map<string, BackgroundJob<T>>()
  let dirOverride: string | undefined
  const dir = (): string => dirOverride ?? opts.defaultDir
  const resultPathFor = (id: string): string => join(dir(), `${id}.json`)
  const idPattern = new RegExp(`^${opts.idPrefix}[0-9a-f]{8}$`)

  const sweepStaleFiles = async (): Promise<void> => {
    try {
      const jobsDir = dir()
      const names = await readdir(jobsDir)
      const cutoff = Date.now() - JOB_RETENTION_MS
      await Promise.all(
        names.map(async name => {
          const filePath = join(jobsDir, name)
          try {
            const info = await stat(filePath)
            if (info.mtimeMs < cutoff) await unlink(filePath)
          } catch {
            // Best effort — a concurrent sweep/writer may have already
            // removed or replaced it.
          }
        }),
      )
    } catch {
      // Directory may not exist yet (no job has ever finished) — fine.
    }
  }

  return {
    setDir(d) {
      dirOverride = d
    },
    dir,
    resultPathFor,
    get: id => jobs.get(id),
    start(run) {
      const startedMs = Date.now()
      for (const [k, j] of jobs) {
        if (j.endedAt && startedMs - Date.parse(j.endedAt) >= JOB_RETENTION_MS) {
          jobs.delete(k)
          if (j.resultPath) void unlink(j.resultPath).catch(() => {})
        }
      }
      void sweepStaleFiles()
      const job: BackgroundJob<T> = {
        id: `${opts.idPrefix}${randomBytes(4).toString("hex")}`,
        status: "running",
        startedAt: new Date(startedMs).toISOString(),
        startedMs,
      }
      jobs.set(job.id, job)
      const promise = run()
      void promise.then(
        async result => {
          // Save the full result before flipping to `done`, so a `resultPath`
          // reported by a status view points at a file that actually exists.
          const jobsDir = dir()
          const resultPath = join(jobsDir, `${job.id}.json`)
          try {
            await mkdir(jobsDir, { recursive: true })
            await writeFile(resultPath, JSON.stringify(result))
            job.resultPath = resultPath
          } catch {
            // Best effort — the in-memory job still carries the result.
          }
          job.status = "done"
          job.endedAt = new Date().toISOString()
          job.result = result
        },
        err => {
          job.status = "failed"
          job.endedAt = new Date().toISOString()
          job.error = err instanceof Error ? err.message : String(err)
        },
      )
      return { job, promise }
    },
    async readResultFile(id) {
      if (!idPattern.test(id)) return undefined
      try {
        return JSON.parse(await readFile(resultPathFor(id), "utf8")) as T
      } catch {
        return undefined
      }
    },
    backgroundView: (job, followUp) => ({
      jobId: job.id,
      status: "running",
      startedAt: job.startedAt,
      followUp: { tool: followUp.tool, args: { jobId: job.id }, pollAfterMs: JOB_POLL_AFTER_MS, hint: followUp.hint },
    }),
    progressView: job =>
      job.status === "failed"
        ? { jobId: job.id, status: job.status, endedAt: job.endedAt, error: job.error }
        : {
            jobId: job.id,
            status: job.status,
            startedAt: job.startedAt,
            elapsedMs: Date.now() - job.startedMs,
            followUp: { pollAfterMs: JOB_POLL_AFTER_MS },
          },
  }
}

/**
 * Wait for `promise` up to `waitMs`; resolves `true` when the window elapsed
 * first (caller should return the background view), `false` when the run
 * settled inside it (fulfilled OR rejected — the caller re-awaits the
 * promise to surface either). The timer is cleared as soon as the run
 * settles, so a 40 s timer is not left alive on a 2 s job.
 */
export function timedOutWaiting(promise: Promise<unknown>, waitMs: number): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const handle = setTimeout(() => resolve(true), waitMs)
    const settled = (): void => {
      clearTimeout(handle)
      resolve(false)
    }
    promise.then(settled, settled)
  })
}
