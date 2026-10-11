/**
 * On-disk session retention — the pass that actually DELETES old session
 * directories (`<sessionsDir>/<id>/`: `index.json`, `events.jsonl`,
 * `terminal.jsonl`, attachments, …).
 *
 * WHY: nothing else ever removes a session dir. `session_gc` archives or
 * forgets the registry DESCRIPTOR, but the dir itself stays forever. On a
 * host running a push-gate, review lanes alone add ~1,000 dirs a day, and
 * every dir costs boot time (`backfillSessionIndexes` / the cold-list scan
 * read one sidecar per dir) plus disk (transcripts reach hundreds of MB).
 *
 * POLICY (two independent thresholds, both by last activity):
 *   - review lanes (`origin: "review"`, or a `review:` label/title) are
 *     deleted once terminal and older than `reviewMaxAgeDays` — DEFAULT 7.
 *   - every other session is deleted only when `maxAgeDays` is configured —
 *     DEFAULT OFF. Real sessions are history a user may come back to; the
 *     daemon never deletes them unless the operator opted in.
 *
 * NEVER deletes:
 *   - a session the registry holds as alive (`running`/`starting`), busy,
 *     awaiting input/permission, or with background tasks in flight;
 *   - a `pinned` or `keepAlive` session;
 *   - an ancestor of a live session (deleting it would orphan the tree);
 *   - a dir whose status is not a recognised terminal one;
 *   - a dir whose transcript files were written to inside the window (a
 *     guard against a stale sidecar on a dir another process still writes).
 * Archived sessions get no special treatment beyond that: archiving is
 * housekeeping, not a request to keep the bytes, so an archived review lane
 * ages out like any other, and an archived regular session only goes when
 * the general threshold is configured.
 *
 * NON-BLOCKING by construction: async fs only, dirs processed in small
 * batches with a `setImmediate` yield between them, so a store with tens of
 * thousands of dirs never stalls the daemon's event loop.
 *
 * Registry consistency: a dir the registry still holds is dropped through
 * `forgetSession` (the same retire-as-"forgotten" + delete + persist path
 * `session_gc forget:true` uses) BEFORE its files are removed, so no
 * in-memory row ever points at a missing transcript.
 */

import { readFile, readdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { resetColdSessionCache } from "./session-cold-list.js"
import type { SessionIndexEntry } from "./session-index.js"
import type { SessionDescriptor } from "./sessions.js"

/** Default age (days) after which a terminal review-lane session dir is deleted. */
export const DEFAULT_REVIEW_SESSION_RETENTION_DAYS = 7
/** Default periodic cadence of the daemon's retention sweep: every 6 h. */
export const DEFAULT_SESSION_RETENTION_INTERVAL_MS = 6 * 60 * 60_000
/** Default delay before the first sweep after boot, so it never competes
 *  with boot-time work. */
export const DEFAULT_SESSION_RETENTION_BOOT_DELAY_MS = 10 * 60_000
/** Dirs examined per batch before yielding to the event loop. */
const BATCH_SIZE = 64
/** Cap on the ids echoed back in a result (the count is always exact). */
const MAX_RESULT_IDS = 500
const DAY_MS = 86_400_000

/** Statuses a session dir may be deleted in. Anything else is kept. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["exited", "killed", "error", "completed", "unknown"])

/** The slice of the sessions registry the pass needs. Structural so the pass
 *  stays unit-testable against a fake. */
export interface SessionRetentionRegistry {
  list(opts?: { includeArchived?: boolean }): readonly SessionDescriptor[]
  /** Drop a terminal session's descriptor (retire as "forgotten" + persist).
   *  `"alive"` ⇒ refused (the row went live since the sweep looked);
   *  `"missing"` ⇒ the registry no longer holds it. */
  forgetSession(id: string): "forgotten" | "missing" | "alive"
}

export interface SessionRetentionOptions {
  /** Delete terminal review-lane dirs older than this many days. Default
   *  {@link DEFAULT_REVIEW_SESSION_RETENTION_DAYS}; `null` / non-positive
   *  disables the review rule. */
  reviewMaxAgeDays?: number | null
  /** Delete ANY terminal session dir older than this many days. Default
   *  off (`undefined` / `null` / non-positive). */
  maxAgeDays?: number | null
  /** Report what would be deleted; touch nothing. */
  dryRun?: boolean
  /** Only consider these ids (a scoped orchestrator's subtree). */
  onlyIds?: ReadonlySet<string>
}

export interface SessionRetentionResult {
  /** False when both thresholds are off — the pass did nothing. */
  enabled: boolean
  dryRun: boolean
  reviewMaxAgeDays: number | null
  maxAgeDays: number | null
  /** Session dirs examined. */
  scanned: number
  /** Dirs deleted (or, under `dryRun`, that would be). */
  count: number
  /** Their ids — capped at {@link MAX_RESULT_IDS}; see `idsTruncated`. */
  ids: string[]
  idsTruncated: boolean
  /** Why eligible-by-age dirs were kept, plus dirs a rule didn't match. */
  kept: {
    protected: number
    notTerminal: number
    tooRecent: number
    noRule: number
  }
  /** Dirs whose deletion failed (left in place; retried next sweep). */
  errors: number
}

/** Normalise a day threshold: positive finite number or null (off). */
function normalizeDays(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null
}

/** Review-lane test: `origin: "review"` or a `review:`-prefixed label/title. */
export function isReviewLaneSession(s: { origin?: string; label?: string; title?: string }): boolean {
  if (s.origin === "review") return true
  return (s.label ?? "").startsWith("review:") || (s.title ?? "").startsWith("review:")
}

/** What the pass knows about one dir, from the registry or its sidecar. */
interface DirView {
  status: string
  origin?: string
  label?: string
  title?: string
  /** Last-activity epoch ms, or undefined when unknown (falls back to mtime). */
  activityMs?: number
}

function parseMs(s: string | undefined): number | undefined {
  if (!s) return undefined
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? ms : undefined
}

function viewFromDescriptor(d: SessionDescriptor): DirView {
  const activityMs = Math.max(
    parseMs(d.lastActivityAt) ?? -Infinity,
    parseMs(d.endedAt) ?? -Infinity,
  )
  return {
    status: d.status,
    ...(d.origin !== undefined ? { origin: d.origin } : {}),
    ...(d.label !== undefined ? { label: d.label } : {}),
    ...(d.title !== undefined ? { title: d.title } : {}),
    ...(Number.isFinite(activityMs)
      ? { activityMs }
      : parseMs(d.startedAt) !== undefined
        ? { activityMs: parseMs(d.startedAt) }
        : {}),
  }
}

async function readIndexView(dir: string): Promise<DirView | undefined> {
  let raw: string
  try {
    raw = await readFile(join(dir, "index.json"), "utf8")
  } catch {
    return undefined
  }
  let entry: Partial<SessionIndexEntry>
  try {
    entry = JSON.parse(raw) as Partial<SessionIndexEntry>
  } catch {
    return undefined
  }
  if (!entry || typeof entry !== "object") return undefined
  // A sidecar for a session the registry does not hold has no process behind
  // it (same reclassification as boot-load / the cold list): a stale
  // `running` reads as killed. The transcript-mtime guard below still keeps
  // a dir someone is actively writing to.
  const status =
    entry.alive === true || entry.status === "running" || entry.status === "starting"
      ? "killed"
      : typeof entry.status === "string"
        ? entry.status
        : "unknown"
  const activityMs = parseMs(entry.lastActivityAt) ?? parseMs(entry.startedAt)
  return {
    status,
    ...(typeof entry.origin === "string" ? { origin: entry.origin } : {}),
    ...(typeof entry.label === "string" ? { label: entry.label } : {}),
    ...(typeof entry.title === "string" ? { title: entry.title } : {}),
    ...(activityMs !== undefined ? { activityMs } : {}),
  }
}

/** Newest mtime among the dir itself and its transcript files. */
async function newestMtimeMs(dir: string): Promise<number | undefined> {
  let newest: number | undefined
  for (const p of [dir, join(dir, "events.jsonl"), join(dir, "terminal.jsonl"), join(dir, "index.json")]) {
    try {
      const s = await stat(p)
      if (newest === undefined || s.mtimeMs > newest) newest = s.mtimeMs
    } catch {
      // absent file — fine
    }
  }
  return newest
}

const yieldToLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/** The ids the registry says must never be deleted. */
function protectedIds(all: readonly SessionDescriptor[]): Set<string> {
  const byId = new Map(all.map(d => [d.id, d]))
  const out = new Set<string>()
  for (const d of all) {
    const live =
      d.status === "running" ||
      d.status === "starting" ||
      d.busy === true ||
      d.awaitingInput === true ||
      d.awaitingPermission === true ||
      (d.pendingBgTasks ?? 0) > 0
    if (live) {
      out.add(d.id)
      // Every ancestor of a live session stays: deleting one orphans the tree.
      let parentId = d.parentSessionId
      const seen = new Set<string>()
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId)
        out.add(parentId)
        parentId = byId.get(parentId)?.parentSessionId
      }
    }
    if (d.pinned === true || d.keepAlive === true) out.add(d.id)
  }
  return out
}

/**
 * Run one retention sweep over `baseDir`. Pure over the injected `now`; all
 * fs work is async and batched.
 */
export async function runSessionRetentionPass(opts: {
  baseDir: string
  registry: SessionRetentionRegistry
  now?: () => number
} & SessionRetentionOptions): Promise<SessionRetentionResult> {
  const reviewMaxAgeDays =
    opts.reviewMaxAgeDays === undefined
      ? DEFAULT_REVIEW_SESSION_RETENTION_DAYS
      : normalizeDays(opts.reviewMaxAgeDays)
  const maxAgeDays = normalizeDays(opts.maxAgeDays)
  const dryRun = opts.dryRun === true
  const result: SessionRetentionResult = {
    enabled: reviewMaxAgeDays !== null || maxAgeDays !== null,
    dryRun,
    reviewMaxAgeDays,
    maxAgeDays,
    scanned: 0,
    count: 0,
    ids: [],
    idsTruncated: false,
    kept: { protected: 0, notTerminal: 0, tooRecent: 0, noRule: 0 },
    errors: 0,
  }
  if (!result.enabled) return result

  const nowMs = opts.now ? opts.now() : Date.now()
  const all = opts.registry.list({ includeArchived: true })
  const byId = new Map(all.map(d => [d.id, d]))
  const keep = protectedIds(all)

  let names: string[]
  try {
    const dirents = await readdir(opts.baseDir, { withFileTypes: true })
    // Real directories only — a symlink is never followed or removed.
    names = dirents.filter(e => e.isDirectory()).map(e => e.name)
  } catch {
    return result
  }

  const consider = async (id: string): Promise<string | undefined> => {
    if (opts.onlyIds && !opts.onlyIds.has(id)) return undefined
    result.scanned++
    if (keep.has(id)) {
      result.kept.protected++
      return undefined
    }
    const dir = join(opts.baseDir, id)
    const desc = byId.get(id)
    const view: DirView = desc
      ? viewFromDescriptor(desc)
      : (await readIndexView(dir)) ?? { status: "unknown" }
    const review = isReviewLaneSession(view)
    const thresholdDays = review
      ? Math.min(reviewMaxAgeDays ?? Infinity, maxAgeDays ?? Infinity)
      : maxAgeDays ?? Infinity
    if (!Number.isFinite(thresholdDays)) {
      result.kept.noRule++
      return undefined
    }
    if (!TERMINAL_STATUSES.has(view.status)) {
      result.kept.notTerminal++
      return undefined
    }
    const cutoff = nowMs - thresholdDays * DAY_MS
    if (view.activityMs !== undefined && view.activityMs > cutoff) {
      result.kept.tooRecent++
      return undefined
    }
    // Last guard (only paid for dirs already past the threshold): the files
    // themselves must be old too. Catches a stale sidecar on a dir another
    // process still appends to, and ages a dir that has no timestamps.
    const mtime = await newestMtimeMs(dir)
    if (mtime === undefined || mtime > cutoff) {
      result.kept.tooRecent++
      return undefined
    }
    return id
  }

  const remove = async (id: string): Promise<void> => {
    if (!dryRun) {
      // Registry first, so no in-memory row outlives its transcript.
      if (byId.has(id) && opts.registry.forgetSession(id) === "alive") {
        result.kept.protected++
        return
      }
      try {
        await rm(join(opts.baseDir, id), { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
      } catch {
        result.errors++
        return
      }
    }
    result.count++
    if (result.ids.length < MAX_RESULT_IDS) result.ids.push(id)
    else result.idsTruncated = true
  }

  for (let i = 0; i < names.length; i += BATCH_SIZE) {
    const batch = names.slice(i, i + BATCH_SIZE)
    const eligible = (await Promise.all(batch.map(consider))).filter((id): id is string => id !== undefined)
    // Deletions run sequentially within the batch: unlinking a multi-hundred-MB
    // transcript is I/O the rest of the daemon shares.
    for (const id of eligible) await remove(id)
    await yieldToLoop()
  }

  if (!dryRun && result.count > 0) resetColdSessionCache()
  return result
}
