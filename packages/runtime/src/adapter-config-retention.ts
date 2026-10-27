/**
 * Adapter-config cache retention: reclaim the cache content of dead
 * sessions' isolated adapter config dirs (`~/.agentproto/adapter-config/<id>/`).
 *
 * WHY: nothing removed those dirs, and neither archiving nor the session-dir
 * retention pass touches them (they hold the provider's resume store, so they
 * outlive the transcript dir on purpose). Their CACHE content is what grows:
 * opencode's per-session shadow git (`snapshot/`), its spilled tool outputs,
 * and, before the driver linked it back to the operator's store, a full pnpm
 * store per session. On one host on 2026-10-27: 1764 dirs, 124 GB.
 *
 * WHAT IS DELETED: only the paths the dir's session cache manifest lists
 * (written by the driver at spawn, see `@agentproto/harness`
 * `session-cache-manifest.ts`), plus {@link LEGACY_CACHE_PATHS} for dirs
 * written before the manifest existed. Everything else stays, so a dead
 * session can still be resumed (opencode's `opencode.db`, claude-code's
 * `projects/*.jsonl`). A listed path that is a symlink (a pnpm store linked
 * to the operator's own) loses the link, never the target.
 *
 * WHEN: the lineage is dead. Every session whose `adapterConfigDir` is this
 * dir (restarts carry it forward) must be terminal, not pinned / keepAlive,
 * not an ancestor of a live session, and quiet for `maxAgeDays` (default 1).
 * A dir no descriptor points at any more is aged by its own mtimes. The
 * mtime guard also applies to owned dirs, against a stale descriptor.
 *
 * Non-blocking like the session-dir pass: async fs, small batches, a yield
 * between them.
 */

import { lstat, readdir, realpath, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { readSessionCacheManifest, safeRelativeCachePath } from "@agentproto/harness"
import { protectedIds, TERMINAL_STATUSES } from "./session-retention.js"
import type { SessionDescriptor } from "./sessions.js"

/** Default quiet time (days) before a dead lineage's caches are reclaimed. */
export const DEFAULT_ADAPTER_CACHE_RETENTION_DAYS = 1
const BATCH_SIZE = 32
const MAX_RESULT_IDS = 500
const DAY_MS = 86_400_000
/** How deep the mtime guard looks into a dir (opencode's db-wal is at 3). */
const MTIME_DEPTH = 3

/**
 * Cache paths of dirs written before the driver recorded a manifest: the
 * opencode credential data home (`auth-data`, `XDG_DATA_HOME`) and the pnpm
 * store it used to grow. Applied to every dir, harmless where absent.
 */
export const LEGACY_CACHE_PATHS: readonly string[] = [
  "auth-data/pnpm/store",
  "auth-data/opencode/snapshot",
  "auth-data/opencode/tool-output",
  "auth-data/opencode/log",
]

/** Root of the per-session adapter config dirs (`adapterConfigDirFor`). */
export function defaultAdapterConfigBaseDir(): string {
  return resolve(homedir(), ".agentproto", "adapter-config")
}

export interface AdapterCacheRetentionRegistry {
  list(opts?: { includeArchived?: boolean }): readonly SessionDescriptor[]
}

export interface AdapterCacheRetentionOptions {
  /** Quiet time (days) before a dead lineage's caches go. Default
   *  {@link DEFAULT_ADAPTER_CACHE_RETENTION_DAYS}; `null` / non-positive
   *  disables the pass. */
  maxAgeDays?: number | null
  dryRun?: boolean
  /** Only dirs owned by these session ids (a scoped orchestrator's subtree). */
  onlyIds?: ReadonlySet<string>
}

export interface AdapterCacheRetentionResult {
  enabled: boolean
  dryRun: boolean
  maxAgeDays: number | null
  /** Config dirs examined. */
  scanned: number
  /** Dirs that had cache content removed (or, under `dryRun`, would). */
  count: number
  /** Cache paths removed across those dirs. */
  paths: number
  /** Dir names, capped at {@link MAX_RESULT_IDS}; see `idsTruncated`. */
  ids: string[]
  idsTruncated: boolean
  kept: {
    /** Nothing listed exists in the dir. */
    nothingToPrune: number
    protected: number
    notTerminal: number
    tooRecent: number
  }
  errors: number
}

function normalizeDays(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null
}

function lastActivityMs(d: SessionDescriptor): number | undefined {
  let best = -Infinity
  for (const s of [d.lastActivityAt, d.endedAt, d.startedAt]) {
    const ms = s ? Date.parse(s) : Number.NaN
    if (Number.isFinite(ms) && ms > best) best = ms
  }
  return Number.isFinite(best) ? best : undefined
}

function isInside(root: string, p: string): boolean {
  const rel = relative(root, p)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

/** Newest mtime in `dir` down to {@link MTIME_DEPTH}, not descending into
 *  the cache paths themselves (their churn is what the pass removes). */
async function newestMtimeMs(dir: string, skip: ReadonlySet<string>): Promise<number | undefined> {
  let newest: number | undefined
  const visit = async (p: string, depth: number): Promise<void> => {
    let s
    try {
      s = await lstat(p)
    } catch {
      return
    }
    if (newest === undefined || s.mtimeMs > newest) newest = s.mtimeMs
    if (!s.isDirectory() || depth >= MTIME_DEPTH || skip.has(p)) return
    let names: string[]
    try {
      names = await readdir(p)
    } catch {
      return
    }
    for (const n of names) {
      const child = join(p, n)
      if (!skip.has(child)) await visit(child, depth + 1)
    }
  }
  await visit(dir, 0)
  return newest
}

/** The listed cache paths that exist in `dir` and resolve inside it. */
async function existingCachePaths(dir: string): Promise<string[]> {
  const listed = new Set<string>(LEGACY_CACHE_PATHS)
  for (const p of readSessionCacheManifest(dir)?.disposable ?? []) listed.add(p)
  let root: string
  try {
    root = await realpath(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const raw of listed) {
    const rel = safeRelativeCachePath(raw)
    if (!rel) continue
    const target = join(dir, rel)
    try {
      await lstat(target)
      // A symlinked parent (`auth-data -> ~/.local/share`) must never let a
      // delete land outside the dir; the target itself may be a link.
      const parent = await realpath(dirname(target))
      if (parent !== root && !isInside(root, parent)) continue
    } catch {
      continue
    }
    out.push(target)
  }
  return out
}

const yieldToLoop = (): Promise<void> => new Promise(r => setImmediate(r))

export async function runAdapterCacheRetentionPass(opts: {
  baseDir?: string
  registry: AdapterCacheRetentionRegistry
  now?: () => number
} & AdapterCacheRetentionOptions): Promise<AdapterCacheRetentionResult> {
  const maxAgeDays =
    opts.maxAgeDays === undefined ? DEFAULT_ADAPTER_CACHE_RETENTION_DAYS : normalizeDays(opts.maxAgeDays)
  const dryRun = opts.dryRun === true
  const result: AdapterCacheRetentionResult = {
    enabled: maxAgeDays !== null,
    dryRun,
    maxAgeDays,
    scanned: 0,
    count: 0,
    paths: 0,
    ids: [],
    idsTruncated: false,
    kept: { nothingToPrune: 0, protected: 0, notTerminal: 0, tooRecent: 0 },
    errors: 0,
  }
  if (maxAgeDays === null) return result
  const baseDir = opts.baseDir ?? defaultAdapterConfigBaseDir()
  const cutoff = (opts.now ? opts.now() : Date.now()) - maxAgeDays * DAY_MS

  const all = opts.registry.list({ includeArchived: true })
  const keep = protectedIds(all)
  // Owners of each dir: the sessions recording it (a restart lineage shares
  // one), plus the session the dir is named after.
  const owners = new Map<string, SessionDescriptor[]>()
  const addOwner = (name: string, d: SessionDescriptor): void => {
    const list = owners.get(name) ?? []
    if (!list.includes(d)) list.push(d)
    owners.set(name, list)
  }
  const base = resolve(baseDir)
  for (const d of all) {
    if (d.adapterConfigDir && dirname(resolve(d.adapterConfigDir)) === base) {
      addOwner(basename(d.adapterConfigDir), d)
    }
    addOwner(d.id, d)
  }

  let names: string[]
  try {
    const dirents = await readdir(baseDir, { withFileTypes: true })
    names = dirents.filter(e => e.isDirectory()).map(e => e.name)
  } catch {
    return result
  }

  const consider = async (name: string): Promise<string[] | undefined> => {
    const own = owners.get(name) ?? []
    if (opts.onlyIds && !own.some(d => opts.onlyIds!.has(d.id))) return undefined
    result.scanned++
    const dir = join(baseDir, name)
    const targets = await existingCachePaths(dir)
    if (targets.length === 0) {
      result.kept.nothingToPrune++
      return undefined
    }
    if (own.some(d => keep.has(d.id))) {
      result.kept.protected++
      return undefined
    }
    if (own.some(d => !TERMINAL_STATUSES.has(d.status))) {
      result.kept.notTerminal++
      return undefined
    }
    if (own.some(d => (lastActivityMs(d) ?? Infinity) > cutoff)) {
      result.kept.tooRecent++
      return undefined
    }
    const mtime = await newestMtimeMs(dir, new Set(targets))
    if (mtime === undefined || mtime > cutoff) {
      result.kept.tooRecent++
      return undefined
    }
    return targets
  }

  for (let i = 0; i < names.length; i += BATCH_SIZE) {
    const batch = names.slice(i, i + BATCH_SIZE)
    const plans = await Promise.all(batch.map(async n => [n, await consider(n)] as const))
    for (const [name, targets] of plans) {
      if (!targets) continue
      let removed = 0
      let failed = false
      for (const t of targets) {
        if (!dryRun) {
          try {
            // `rm` unlinks a symlink itself, never what it points at.
            await rm(t, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
          } catch {
            failed = true
            continue
          }
        }
        removed++
      }
      if (failed) result.errors++
      if (removed === 0) continue
      result.count++
      result.paths += removed
      if (result.ids.length < MAX_RESULT_IDS) result.ids.push(name)
      else result.idsTruncated = true
    }
    await yieldToLoop()
  }
  return result
}
