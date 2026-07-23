/**
 * Provenance — which session(s) worked in this worktree, historically,
 * including dead ones (PLAN.md §1.5). Not a fourth status axis: it never
 * changes `class`, only triage ("what was the session doing when it
 * stranded these files?").
 *
 * The join is over the EXISTING sessions registry
 * (`packages/runtime/src/sessions.ts`) — upholding the no-registry
 * principle (PLAN.md §1.4): nothing new is mirrored, this only reads
 * files another package already owns and persists. Read directly off disk
 * (not via a running daemon) so `worktree ls --status` works with no
 * daemon required, matching `worktree check`'s posture (PLAN.md §3.3).
 *
 * ## Where the registry lives (AIP-46 §State partitioning)
 *
 * It is no longer one file. The runtime partitions per workspace —
 * `~/.agentproto/workspaces/<slug>/sessions.json` — and leaves the old
 * global `~/.agentproto/sessions.json` in place, frozen, as the
 * pre-partition history. So the default read is the UNION of every bucket
 * plus that legacy artifact.
 *
 * Reading only the legacy file would be quietly destructive here rather
 * than merely stale: this feeds `computeWorktreeStatus` → the GC plan →
 * `applyGc`, which REMOVES worktrees. A worktree whose sessions all live
 * in a bucket would present as never-touched and become eligible for
 * removal. Under-reporting provenance deletes work; over-reporting only
 * keeps a worktree around. The union is the safe direction, and the
 * legacy file stays in the union precisely because provenance's job is
 * history.
 *
 * The bucket layout is duplicated here rather than imported, matching
 * what this file already did with the sessions path: `@agentproto/worktree`
 * does not depend on `@agentproto/runtime` and this join is not worth
 * inverting that.
 *
 * Two known limits, both designed in rather than hidden (PLAN.md §1.5):
 *   - each snapshot is a recency window (`HISTORY_CAP = 200` per bucket,
 *     `packages/runtime/src/sessions.ts`), not an archive — an old
 *     worktree's sessions may already be evicted.
 *   - Without a per-worktree creation marker, the join can span
 *     generations (a worktree removed and recreated at the same path
 *     inherits the old generation's sessions). PR-B writes that marker
 *     (`agentproto-worktree.json` in the worktree's private gitdir); this PR
 *     only reads it if present and is honest — `confidence: "best-effort"`
 *     — when it's absent, which is every worktree today.
 */

import { readdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { sep } from "node:path"
import { resolve } from "node:path"
import { z } from "zod"
import { execArgv } from "./exec.js"

/** The pre-partition global snapshot. Still read — it holds every session
 *  from before the split and the runtime leaves it intact — but no longer
 *  written. See this file's header. */
export const SESSIONS_FILE_PATH = (): string => resolve(homedir(), ".agentproto", "sessions.json")

/** Root of the runtime's per-workspace state buckets (AIP-46 §Layout):
 *  `<root>/<slug>/sessions.json`. */
export const SESSIONS_BUCKETS_ROOT = (): string => resolve(homedir(), ".agentproto", "workspaces")

/** The subset of `SessionDescriptor` (`packages/runtime/src/sessions.ts`) provenance needs. */
const sessionRefSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  status: z.string(),
  cwd: z.string().optional(),
  // Optional echoes from SessionDescriptor; kept optional for back-compat with
  // registry rows written before these fields were persisted. The GC logic
  // ignores them; they are surfaced in local provenance footers.
  adapterSlug: z.string().optional(),
  model: z.string().optional(),
  authMode: z.string().optional(),
  costUsd: z.number().optional(),
  tokensIn: z.number().optional(),
  tokensOut: z.number().optional(),
})
export type SessionRef = z.infer<typeof sessionRefSchema>

const sessionsFileSchema = z.object({ sessions: z.array(z.unknown()) })

export type ProvenanceConfidence = "exact" | "best-effort"

export interface ProvenanceInfo {
  confidence: ProvenanceConfidence
  sessions: SessionRef[]
}

/**
 * Read the persisted sessions registry.
 *
 * With `path`: that exact file, nothing else — what callers pinning a
 * fixture want.
 *
 * Without: the union of every per-workspace bucket plus the legacy global
 * snapshot (see this file's header for why the union, and why
 * under-reporting here is dangerous rather than merely lossy). Deduped by
 * session id, buckets winning over the frozen legacy copy of the same row.
 *
 * Missing file (no daemon has ever run) is a legitimate empty registry,
 * not an error — mirrors `loadHistorySnapshot`'s own ENOENT handling in
 * `sessions.ts`. A malformed file (present but unparseable) is surfaced by
 * returning `null` so callers can distinguish "no history" from "history
 * is unreadable"; in the union that means null only when every source that
 * exists is unreadable, since one corrupt bucket shouldn't blind the join
 * to the rest.
 */
export async function readSessionsRegistry(path?: string): Promise<SessionRef[] | null> {
  if (path !== undefined) return readSessionsFile(path)

  let buckets: string[] = []
  try {
    const root = SESSIONS_BUCKETS_ROOT()
    buckets = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => resolve(root, e.name, "sessions.json"))
  } catch {
    buckets = [] // ENOENT — nothing partitioned yet.
  }

  // Buckets first: on an id present in both, the live bucket row wins
  // over the frozen legacy one.
  const results = await Promise.all(
    [...buckets, SESSIONS_FILE_PATH()].map((p) => readSessionsFile(p)),
  )
  const readable = results.filter((r): r is SessionRef[] => r !== null)
  if (readable.length === 0) return null

  const byId = new Map<string, SessionRef>()
  for (const list of readable) {
    for (const session of list) {
      if (!byId.has(session.id)) byId.set(session.id, session)
    }
  }
  return Array.from(byId.values())
}

async function readSessionsFile(path: string): Promise<SessionRef[] | null> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (err) {
    if (typeof err === "object" && err !== null && Reflect.get(err, "code") === "ENOENT") return []
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const file = sessionsFileSchema.safeParse(parsed)
  if (!file.success) return null
  const refs: SessionRef[] = []
  for (const entry of file.data.sessions) {
    const rawEntry = entry as Record<string, unknown> | undefined
    const ref = sessionRefSchema.safeParse({
      ...rawEntry,
      // SessionDescriptor stores billing-auth mode under `auth.mode`; mirror it
      // onto the flattened `authMode` field for footer consumers.
      authMode: rawEntry?.authMode ?? (rawEntry?.auth as { mode?: string } | undefined)?.mode,
    })
    if (ref.success) refs.push(ref.data)
  }
  return refs
}

/** `session.cwd == wtPath || session.cwd.startsWith(wtPath + sep)` (PLAN.md §1.5 — containment, not equality). */
export function sessionInWorktree(session: SessionRef, worktreePath: string): boolean {
  if (session.cwd === undefined) return false
  return session.cwd === worktreePath || session.cwd.startsWith(worktreePath + sep)
}

/** The creation marker PR-B writes into `$(git rev-parse --git-dir)/agentproto-worktree.json`. */
const worktreeMarkerSchema = z.object({
  worktreeId: z.string(),
  createdAt: z.string(),
  createdBySessionId: z.string().optional(),
})
export type WorktreeMarker = z.infer<typeof worktreeMarkerSchema>

/**
 * Read the per-worktree creation marker, if PR-B has written one. This PR
 * never writes it — only reads, so a worktree created before PR-B shipped
 * (all of them, today) honestly reports `confidence: "best-effort"`.
 *
 * Spawn `cwd` is anchored to `repoRoot`, NOT `worktreePath` — `worktreePath`
 * targets the git command via `-C`, but a linked worktree can be removed by
 * a concurrent `gc` reap (or by this very call's caller, moments later) while
 * `repoRoot` (the main checkout) never is (`gc.ts`'s docblock: git itself
 * refuses to remove the main working tree). A spawn whose `cwd` no longer
 * exists on disk fails `ENOENT` on the COMMAND itself (a Node/libuv quirk,
 * not a "not found" for the directory) — see `exec.ts`'s `execGit` for the
 * same anchor, established first.
 */
export async function readWorktreeMarker(repoRoot: string, worktreePath: string): Promise<WorktreeMarker | null> {
  const gitDirRes = await execArgv(
    "git",
    ["-C", worktreePath, "rev-parse", "--path-format=absolute", "--git-dir"],
    repoRoot,
  )
  if (gitDirRes.exitCode !== 0) return null
  const gitDir = gitDirRes.stdout.trim()
  if (!gitDir) return null
  let raw: string
  try {
    raw = await readFile(resolve(gitDir, "agentproto-worktree.json"), "utf8")
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const result = worktreeMarkerSchema.safeParse(parsed)
  return result.success ? result.data : null
}

/**
 * Write the creation marker into `$(git rev-parse --git-dir)/agentproto-
 * worktree.json` — the worktree's own private gitdir, not the shared
 * `.git/config` (PLAN.md §1.5 rejected `git config --local` for exactly
 * this reason: in a linked worktree it reads/writes the main repo's shared
 * config, so it wouldn't die with the worktree and would collide across
 * worktrees). Called once, by `worktree.provision`, right after the
 * worktree is created; nothing else ever rewrites it.
 *
 * Spawn `cwd` is anchored to `repoRoot`, not `worktreePath` — see
 * `readWorktreeMarker`'s doc for why.
 */
export async function writeWorktreeMarker(
  repoRoot: string,
  worktreePath: string,
  marker: WorktreeMarker,
): Promise<void> {
  const gitDirRes = await execArgv(
    "git",
    ["-C", worktreePath, "rev-parse", "--path-format=absolute", "--git-dir"],
    repoRoot,
  )
  if (gitDirRes.exitCode !== 0) {
    throw new Error(
      `git rev-parse --git-dir failed in ${worktreePath} (exit ${gitDirRes.exitCode}): ${gitDirRes.stderr.trim()}`,
    )
  }
  const gitDir = gitDirRes.stdout.trim()
  await writeFile(resolve(gitDir, "agentproto-worktree.json"), JSON.stringify(marker, null, 2) + "\n", "utf8")
}

export interface ComputeProvenanceOptions {
  sessionsPath?: string
}

/**
 * The §1.5 join: sessions whose `cwd` is contained in `worktreePath`,
 * bounded by the marker's `createdAt` when present (filters out sessions
 * from a prior generation at the same path). `confidence` is `"exact"` only
 * when that marker exists; otherwise `"best-effort"` — the join may span
 * generations and is bounded by `HISTORY_CAP`'s recency window.
 */
export async function computeProvenance(
  repoRoot: string,
  worktreePath: string,
  options: ComputeProvenanceOptions = {},
): Promise<ProvenanceInfo> {
  const [registry, marker] = await Promise.all([
    // No `sessionsPath` ⇒ the bucket ∪ legacy union, NOT the legacy file
    // alone — pinning it here would hide every partitioned session from
    // the GC join. See this file's header.
    readSessionsRegistry(options.sessionsPath),
    readWorktreeMarker(repoRoot, worktreePath),
  ])
  const sessions = registry ?? []
  const matched = sessions
    .filter((s) => sessionInWorktree(s, worktreePath))
    .filter((s) => (marker ? s.startedAt >= marker.createdAt : true))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  return {
    confidence: marker ? "exact" : "best-effort",
    sessions: matched,
  }
}
