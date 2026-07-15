/**
 * Provenance — which session(s) worked in this worktree, historically,
 * including dead ones (PLAN.md §1.5). Not a fourth status axis: it never
 * changes `class`, only triage ("what was the session doing when it
 * stranded these files?").
 *
 * The join is over the EXISTING sessions registry
 * (`~/.agentproto/sessions.json`, `packages/runtime/src/sessions.ts`) —
 * upholding the no-registry principle (PLAN.md §1.4): nothing new is
 * mirrored, this only reads a file another package already owns and
 * persists. Read directly off disk (not via a running daemon) so `worktree
 * ls --status` works with no daemon required, matching `worktree check`'s
 * posture (PLAN.md §3.3).
 *
 * Two known limits, both designed in rather than hidden (PLAN.md §1.5):
 *   - `sessions.json` is a recency window (`HISTORY_CAP = 200`,
 *     `packages/runtime/src/sessions.ts:583`), not an archive — an old
 *     worktree's sessions may already be evicted.
 *   - Without a per-worktree creation marker, the join can span
 *     generations (a worktree removed and recreated at the same path
 *     inherits the old generation's sessions). PR-B writes that marker
 *     (`agentproto-worktree.json` in the worktree's private gitdir); this PR
 *     only reads it if present and is honest — `confidence: "best-effort"`
 *     — when it's absent, which is every worktree today.
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { sep } from "node:path"
import { resolve } from "node:path"
import { z } from "zod"
import { execArgv } from "./exec.js"

export const SESSIONS_FILE_PATH = (): string => resolve(homedir(), ".agentproto", "sessions.json")

/** The subset of `SessionDescriptor` (`packages/runtime/src/sessions.ts`) provenance needs. */
const sessionRefSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  status: z.string(),
  cwd: z.string().optional(),
})
export type SessionRef = z.infer<typeof sessionRefSchema>

const sessionsFileSchema = z.object({ sessions: z.array(z.unknown()) })

export type ProvenanceConfidence = "exact" | "best-effort"

export interface ProvenanceInfo {
  confidence: ProvenanceConfidence
  sessions: SessionRef[]
}

/**
 * Read the persisted sessions snapshot. Missing file (no daemon has ever
 * run) is a legitimate empty registry, not an error — mirrors
 * `loadHistorySnapshot`'s own ENOENT handling in `sessions.ts`. A malformed
 * file (present but unparseable) is surfaced by returning `null` so callers
 * can distinguish "no history" from "history is unreadable".
 */
export async function readSessionsRegistry(path: string = SESSIONS_FILE_PATH()): Promise<SessionRef[] | null> {
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
    const ref = sessionRefSchema.safeParse(entry)
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
 */
export async function readWorktreeMarker(worktreePath: string): Promise<WorktreeMarker | null> {
  const gitDirRes = await execArgv(
    "git",
    ["-C", worktreePath, "rev-parse", "--path-format=absolute", "--git-dir"],
    worktreePath,
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
  worktreePath: string,
  options: ComputeProvenanceOptions = {},
): Promise<ProvenanceInfo> {
  const [registry, marker] = await Promise.all([
    readSessionsRegistry(options.sessionsPath ?? SESSIONS_FILE_PATH()),
    readWorktreeMarker(worktreePath),
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
