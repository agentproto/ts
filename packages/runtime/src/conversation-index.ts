/**
 * Persisted conversation index — the session ↔ native-transcript link,
 * stored instead of re-derived (DESIGN.md `agentproto-state-multitenancy`
 * §6).
 *
 * Today the link between an agentproto session and the original
 * claude/hermes conversation file is DERIVED on every read, through
 * `claudeCodeProjectDir`/`claudeProjectSlug` (conversation-store.ts) — and
 * until that function was fixed, derived *wrong* for any cwd containing a
 * dot. Re-deriving is also blind to cwd drift (a worktree that moved) and
 * carries no record of subagent transcripts at all.
 *
 * This module is the fix: an **append-only** `conversations.jsonl`, one
 * per workspace bucket (co-located with that bucket's `sessions.json`,
 * `workspace-buckets.ts`), upserted by `sessionId` — readers take the LAST
 * record per id. Append-only is deliberate, not incidental: it is immune
 * to the wholesale-rewrite clobber `sessions.ts`'s `persistSnapshot`
 * already has (see DESIGN.md §1) — a writer can only ever ADD a line, so a
 * second process racing a first can't shrink what's on disk.
 *
 * Write points (best-effort, mirroring how `transcriptWriter`/
 * `persistSnapshot` never throw into the turn path): session spawn, an
 * ACP-level resume, and a native graceful-exit resume-hint — see
 * `sessions.ts`'s calls into `recordConversationLink`.
 *
 * No tenant layer yet — the index lives directly under the workspace
 * bucket dir today (`bucketDir(bucketsRoot, slug)/conversations.jsonl`);
 * DESIGN.md §9 notes it migrates under `tenants/<t>/…` at a later PR.
 */

import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve as resolvePath } from "node:path"
import { claudeCodeProjectDir } from "./conversation-store.js"
import { bucketDir } from "./workspace-buckets.js"

/** The claude-code native store: one jsonl per conversation, plus any
 *  subagent transcripts nested under `<sessionId>/subagents/agent-*.jsonl`. */
export interface ClaudeNativeRef {
  kind: "claude-jsonl"
  path: string
  subagents: string[]
}

/** The hermes native store: a row in a shared sqlite db, keyed by the same
 *  id agentproto already records as `adapterSessionId` — no path to derive. */
export interface HermesNativeRef {
  kind: "hermes-sqlite"
  dbPath: string
  rowId: string
}

export type ConversationNativeRef = ClaudeNativeRef | HermesNativeRef

export interface ConversationIndexRecord {
  sessionId: string
  workspace: string
  cwd: string
  adapterSlug: string
  adapterSessionId: string
  /** The session's isolated provider config dir at write time (see
   *  `ResolveNativeLinkInput.adapterConfigDir`) — recorded so readers
   *  that go through the store abstraction (`store.read`, not
   *  `native.path`) can resolve the same isolated dir. Absent on
   *  pre-#824 rows and native PTY sessions. */
  adapterConfigDir?: string
  /** Absent when `adapterSlug` has no known native store (an adapter
   *  outside claude-code/hermes) — the record still links session ↔
   *  cwd ↔ adapterSessionId, it just can't point at a native file. */
  native?: ConversationNativeRef
  agentprotoTranscript: string
  title?: string
  startedAt: string
  endedAt?: string
}

/** Absolute path to a workspace bucket's conversation index. Sibling of
 *  `bucketSessionsFile` in `workspace-buckets.ts`, same root/slug rule. */
export function conversationIndexPath(bucketsRoot: string, slug: string): string {
  return join(bucketDir(bucketsRoot, slug), "conversations.jsonl")
}

/** `<claude-project-dir>/<adapterSessionId>/subagents/agent-*.jsonl`,
 *  sorted for a stable diff/read. `[]` (not a throw) when the session has
 *  no subagents yet, or the dir doesn't exist — a normal answer, not an
 *  error: most sessions never spawn one. */
async function listClaudeSubagents(
  projectDir: string,
  adapterSessionId: string,
): Promise<string[]> {
  const dir = join(projectDir, adapterSessionId, "subagents")
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }
  return entries
    .filter(e => e.startsWith("agent-") && e.endsWith(".jsonl"))
    .map(e => join(dir, e))
    .sort()
}

export interface ResolveNativeLinkInput {
  cwd: string
  adapterSlug: string
  adapterSessionId: string
  /** The session's isolated provider config dir (`SessionDescriptor.
   *  adapterConfigDir`): since #824 a daemon-spawned claude-code session
   *  writes its transcripts under `<adapterConfigDir>/projects/<slug>`,
   *  not `~/.claude/projects/<slug>`. Absent for a native PTY or a
   *  pre-#824 row — the global dir applies. */
  adapterConfigDir?: string
}

/**
 * Resolve where THIS provider keeps this conversation, computed once (at
 * a write point) rather than re-derived on every read. Claude-code's path
 * uses the corrected `claudeProjectSlug` via `claudeCodeProjectDir` — the
 * whole point of pairing this module with the encoder fix in the same PR.
 * Returns `undefined` for an adapter with no known native store (e.g.
 * mastracode, claude-sdk) — a record without `native` is still useful
 * (session ↔ cwd ↔ adapterSessionId), it just has nothing further to add.
 */
export async function resolveNativeLink(
  input: ResolveNativeLinkInput,
): Promise<ConversationNativeRef | undefined> {
  const { cwd, adapterSlug, adapterSessionId, adapterConfigDir } = input
  if (adapterSlug === "claude-code") {
    const dir = claudeCodeProjectDir(cwd, adapterConfigDir)
    const path = join(dir, `${adapterSessionId}.jsonl`)
    const subagents = await listClaudeSubagents(dir, adapterSessionId)
    return { kind: "claude-jsonl", path, subagents }
  }
  if (adapterSlug === "hermes") {
    return {
      kind: "hermes-sqlite",
      dbPath: join(homedir(), ".hermes", "state.db"),
      rowId: adapterSessionId,
    }
  }
  return undefined
}

/** Append one record. Never rewrites — the caller decides when a fresher
 *  snapshot of the same session is worth a new line; readers always take
 *  the last one. Creates the bucket dir if this is its first conversation
 *  record (a bucket that has only ever held terminal/command sessions
 *  won't have one yet). */
export async function appendConversationRecord(
  bucketsRoot: string,
  slug: string,
  record: ConversationIndexRecord,
): Promise<void> {
  const path = conversationIndexPath(bucketsRoot, slug)
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.appendFile(path, JSON.stringify(record) + "\n", "utf8")
}

function isConversationIndexRecord(value: unknown): value is ConversationIndexRecord {
  if (!value || typeof value !== "object") return false
  const r = value as Record<string, unknown>
  return (
    typeof r.sessionId === "string" &&
    typeof r.workspace === "string" &&
    typeof r.cwd === "string" &&
    typeof r.adapterSlug === "string" &&
    typeof r.adapterSessionId === "string" &&
    typeof r.agentprotoTranscript === "string" &&
    typeof r.startedAt === "string"
  )
}

/** Read one bucket's index, upserted by `sessionId` — a line later in the
 *  file always wins over an earlier one for the same id, append-only's
 *  upsert semantics. A malformed line (partial write, hand-edited garbage)
 *  is skipped, not fatal — the rest of the file still reads. `[]` (not a
 *  throw) when the bucket has no index yet. */
export async function readConversationIndex(
  bucketsRoot: string,
  slug: string,
): Promise<ConversationIndexRecord[]> {
  const path = conversationIndexPath(bucketsRoot, slug)
  let raw: string
  try {
    raw = await fs.readFile(path, "utf8")
  } catch {
    return []
  }
  const bySession = new Map<string, ConversationIndexRecord>()
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue // malformed line — skip, never fatal
    }
    if (!isConversationIndexRecord(parsed)) continue
    bySession.set(parsed.sessionId, parsed)
  }
  return Array.from(bySession.values())
}

/** Forward lookup within one already-known bucket. */
export async function findConversationRecord(
  bucketsRoot: string,
  slug: string,
  sessionId: string,
): Promise<ConversationIndexRecord | undefined> {
  const rows = await readConversationIndex(bucketsRoot, slug)
  return rows.find(r => r.sessionId === sessionId)
}

export interface LocatedConversation {
  workspace: string
  record: ConversationIndexRecord
}

/** Forward lookup: sessionId → its record, scanning every bucket (the
 *  caller doesn't have to know which workspace a session landed in).
 *  `undefined` when no bucket's index has ever recorded this session. */
export async function locateConversationBySessionId(
  bucketsRoot: string,
  listBuckets: () => string[],
  sessionId: string,
): Promise<LocatedConversation | undefined> {
  for (const slug of listBuckets()) {
    const record = await findConversationRecord(bucketsRoot, slug, sessionId)
    if (record) return { workspace: slug, record }
  }
  return undefined
}

export interface LocatedConversationByPath extends LocatedConversation {
  /** Set when the match was a subagent transcript rather than the root
   *  conversation file — the path that actually matched. */
  matchedSubagentPath?: string
}

/** Reverse lookup: a native jsonl path (root conversation OR a subagent
 *  transcript) → the agentproto session/workspace that owns it. Scans
 *  every bucket's index; paths are compared after `path.resolve` so a
 *  relative or `..`-bearing argument still matches an absolute recorded
 *  one. Only meaningful for claude-code's `native.path`/`native.subagents`
 *  — hermes has no per-conversation file to reverse-lookup from. */
export async function locateConversationByNativePath(
  bucketsRoot: string,
  listBuckets: () => string[],
  nativePath: string,
): Promise<LocatedConversationByPath | undefined> {
  const target = resolvePath(nativePath)
  for (const slug of listBuckets()) {
    const rows = await readConversationIndex(bucketsRoot, slug)
    for (const record of rows) {
      if (!record.native || record.native.kind !== "claude-jsonl") continue
      if (resolvePath(record.native.path) === target) {
        return { workspace: slug, record }
      }
      const matchedSubagentPath = record.native.subagents.find(
        p => resolvePath(p) === target,
      )
      if (matchedSubagentPath) {
        return { workspace: slug, record, matchedSubagentPath }
      }
    }
  }
  return undefined
}
