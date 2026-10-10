/**
 * Cold history fallback — the sessions the registry cannot hold.
 *
 * `HISTORY_CAP` bounds how many descriptors the registry reinflates at boot
 * (`loadHistorySnapshot` slices each bucket to the newest {@link HISTORY_CAP}
 * rows). Everything older survives on disk — its `index.json` sidecar and its
 * `events.jsonl` transcript are never swept — but it is invisible to
 * `session_list` / `session_search` / `conversation_read`, which answer only
 * from the in-memory map. On a busy host that cap is reached in ordinary use,
 * so "the session I ran last Tuesday" is a real row on disk that no tool can
 * return.
 *
 * This module is the read side of that gap: map the on-disk sidecar back into
 * a {@link SessionDescriptor} so the existing listers can serve it. Rules:
 *
 *  - NEVER overrides the live registry: callers drop any cold row whose id
 *    the registry already holds (a live row is authoritative).
 *  - marked `cold: true`, and terminal (`alive: false`) — the registry has no
 *    process for it, so a sidecar that still claims `running`/`starting` is
 *    stale (the same reclassification boot-load applies) and lands `killed`.
 *  - cached for {@link COLD_TTL_MS} per base dir: the fallback is a
 *    best-effort rescue, not a hot path, and a store with thousands of
 *    sidecars must not be re-scanned on every poll.
 *
 * Pure apart from the explicit disk reads; the callers own scoping, filters
 * and pagination.
 */

import {
  deriveIndexFromTranscript,
  readAllSessionIndexes,
  readSessionIndex,
  type SessionIndexEntry,
} from "./session-index.js"
import { defaultTranscriptBaseDir } from "./transcript-writer.js"
import type { SessionDescriptor, SessionKind, SessionStatus } from "./sessions.js"

/** How long one cold scan is reused before the store is re-read. */
export const COLD_TTL_MS = 30_000

const SESSION_KINDS: readonly string[] = ["terminal", "agent-cli", "command", "browser", "external"]
const TERMINAL_STATUSES: readonly string[] = ["exited", "killed", "error"]

/**
 * Map a sidecar entry (or a transcript-derived one) back to a descriptor.
 * Everything the sidecar knows is passed through; everything it cannot know
 * (a pid, liveness, queued prompts, in-flight flags) is deliberately absent
 * rather than guessed.
 */
export function sessionDescriptorFromIndexEntry(entry: SessionIndexEntry): SessionDescriptor {
  const kind: SessionKind = SESSION_KINDS.includes(entry.kind) ? (entry.kind as SessionKind) : "agent-cli"
  // A sidecar written while the session was alive says so — but the registry
  // not holding the row means no process backs it (same reasoning as
  // `loadHistorySnapshot`'s daemon-restart reclassification).
  const status: SessionStatus = TERMINAL_STATUSES.includes(entry.status)
    ? (entry.status as SessionStatus)
    : "killed"
  return {
    id: entry.id,
    kind,
    workspaceSlug: entry.workspaceSlug ?? "default",
    command: entry.title ?? entry.label ?? "",
    pid: null,
    status,
    alive: false,
    cold: true,
    startedAt: entry.startedAt,
    ...(entry.lastActivityAt !== undefined ? { lastActivityAt: entry.lastActivityAt } : {}),
    ...(entry.label !== undefined ? { label: entry.label } : {}),
    ...(entry.title !== undefined ? { title: entry.title } : {}),
    ...(entry.renamedByUser !== undefined ? { renamedByUser: entry.renamedByUser } : {}),
    ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
    ...(entry.adapter !== undefined ? { adapterSlug: entry.adapter } : {}),
    ...(entry.model !== undefined ? { model: entry.model } : {}),
    ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
    ...(entry.depth !== undefined ? { depth: entry.depth } : {}),
    ...(entry.parentSessionId !== undefined ? { parentSessionId: entry.parentSessionId } : {}),
    ...(entry.turnsCompleted !== undefined ? { turnsCompleted: entry.turnsCompleted } : {}),
    ...(entry.costUsd !== undefined ? { costUsd: entry.costUsd } : {}),
    ...(entry.lastTurnReason !== undefined ? { lastTurnReason: entry.lastTurnReason } : {}),
    ...(entry.archived === true ? { archived: true } : {}),
  }
}

interface ColdCache {
  at: number
  baseDir: string
  rows: SessionDescriptor[]
}

let cache: ColdCache | undefined

/** Drop the cold-scan cache — tests, and a caller that just rewrote the store. */
export function resetColdSessionCache(): void {
  cache = undefined
}

/**
 * Every session the registry is NOT holding, newest activity first. One
 * directory scan per {@link COLD_TTL_MS} window per base dir.
 */
export function coldSessionRows(
  baseDir?: string,
  now: number = Date.now(),
): SessionDescriptor[] {
  const dir = baseDir ?? defaultTranscriptBaseDir()
  if (cache && cache.baseDir === dir && now - cache.at < COLD_TTL_MS) return cache.rows
  const rows = readAllSessionIndexes(dir).map(sessionDescriptorFromIndexEntry)
  cache = { at: now, baseDir: dir, rows }
  return rows
}

/**
 * One cold session by id — the `conversation_read` rescue path. Targeted
 * (one sidecar read, or one bounded transcript tail when the sidecar is
 * missing), never the full scan.
 */
export function coldSessionDescriptor(
  idOrName: string,
  baseDir?: string,
): SessionDescriptor | undefined {
  const entry = readSessionIndex(idOrName, baseDir) ?? deriveIndexFromTranscript(idOrName, baseDir)
  return entry ? sessionDescriptorFromIndexEntry(entry) : undefined
}
