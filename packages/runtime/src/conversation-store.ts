/**
 * Conversation as pivot: one store abstraction per provider, read on any
 * session. A "conversation" is the provider's own persisted session — the
 * durable object. An agentproto session (ACP or PTY) is just an attachment
 * to it. `CONVERSATION_STORES` is the single source of truth for "where does
 * this provider keep its conversations, and how do I read/attach to one" —
 * `RESUME_STRATEGIES` (resume-strategies.ts) and `EXPORT_STRATEGIES`
 * (transcript-export.ts) are thin adapters over it so the two historically
 * drifted tables can never diverge again.
 */

import { promises as fs, createReadStream } from "node:fs"
import { homedir } from "node:os"
import { createInterface } from "node:readline"
import { join, resolve } from "node:path"
import type { ExportedSession, ExportedMessage } from "./transcript-export.js"

/** Where a captured conversation id is recorded on the descriptor.
 *  Same union as resume-strategies.ts's ResumeMetadataKey — re-exported
 *  from there, NOT redefined, so the two can never drift. */
export type { ResumeMetadataKey } from "./resume-strategies.js"
import type { ResumeMetadataKey } from "./resume-strategies.js"

/** One conversation found in a provider's native store, plus enough
 *  evidence for a caller (or a human) to pick between several. */
export interface ConversationCandidate {
  /** The provider-native conversation id (claude: the jsonl uuid). */
  conversationId: string
  startedAt?: string
  lastActivityAt?: string
  messageCount?: number
  /** First user message, truncated to ~120 chars. Disambiguation aid. */
  preview?: string
  /** Which attachment wrote the tail, provider-native vocabulary
   *  (claude-code: "sdk-ts" = ACP arm, "cli" = native TUI). */
  lastWriter?: string
}

export interface DiscoverInput {
  cwd: string
  /** Only consider conversations active at-or-after this ISO ts. */
  since?: string
  /** Only consider conversations that STARTED at-or-before this ISO ts —
   *  an upper bound, typically a dead session's `endedAt`. A conversation
   *  whose own first message postdates it provably belongs to some other,
   *  later session. Omit for a live/ongoing session (no `endedAt` yet) —
   *  it must keep matching conversations that started after `since` with
   *  no upper bound. Conservative: a candidate with no discoverable
   *  `startedAt` is never dropped by this filter. */
  until?: string
  /** The requesting session's attachment mode, in ABSTRACT (provider-
   *  agnostic) vocabulary — `"native"` for a real PTY/TUI attach,
   *  `"acp"` for the agent-cli/ACP arm. When set, drops candidates whose
   *  `lastWriter` is present and maps to the OPPOSITE mode (a native PTY's
   *  conversation is never written by the ACP arm, and vice versa).
   *  Conservative: a candidate with no `lastWriter` is never dropped, and
   *  omitting this field applies no mode filtering at all. */
  attachmentMode?: "native" | "acp"
  /** When set, bind to EXACTLY this conversation or return [].
   *  MUST NOT fall back to a recency guess — see invariants. */
  expectedId?: string
}

export interface ConversationStore {
  storeAs: ResumeMetadataKey
  /** Capture the conversation id from a live output line; group 1 = the id. */
  outputHint?: RegExp
  /** argv that attaches a NATIVE PTY to an existing conversation.
   *  Omitted ⇒ this provider has no native attach path. */
  attachArgv?(conversationId: string): string[]
  /** Find conversations in the provider's native store. `[]` = none —
   *  a normal answer (e.g. the PTY is a bash shell). Never throws for
   *  "nothing found"; throws only on a genuinely unreadable store. */
  discover(input: DiscoverInput): Promise<ConversationCandidate[]>
  /** Read a full conversation into the shared export model. */
  read(conversationId: string, cwd?: string): Promise<ExportedSession>
  /** Follow a conversation live. Resolves to an unsubscribe fn.
   *  Omitted ⇒ no live tail for this provider (caller polls `read`). */
  follow?(input: {
    conversationId: string
    cwd?: string
    onMessage: (m: ExportedMessage) => void
  }): Promise<() => void>
}

// ── claude-code store ──────────────────────────────────────────────────
//
// Native store: ~/.claude/projects/<cwd-encoded>/<uuid>.jsonl, one file per
// conversation. `<cwd-encoded>` is the absolute cwd run through
// `claudeProjectSlug` (claude's own convention — see that function's
// docblock for the empirically-verified rule).

interface ClaudeJsonlMeta {
  type?: string
  timestamp?: string
  entrypoint?: string
  message?: { role?: string; content?: unknown }
}

/**
 * Claude Code's own `cwd` → project-dir-name encoder.
 *
 * The real rule (verified empirically against `~/.claude/projects/`
 * directory names for dozens of known cwds, including dotted worktree
 * paths and macOS temp dirs): every character that is NOT `[a-zA-Z0-9]`
 * is replaced 1:1 with `-`. Crucially, runs of consecutive non-alnum
 * characters are NOT collapsed — each input character produces exactly
 * one output character.
 *
 * This used to be `cwd.replace(/\//g, "-")` — slashes only. That's wrong
 * for any cwd containing a dot (every `.agentproto` worktree, any
 * dotdir), an underscore-prefixed segment, a space, etc., because those
 * characters are left untouched instead of becoming `-`, so the computed
 * directory never matches the one claude actually created.
 *
 * Reconstruction proof (both real, both `ls ~/.claude/projects/`-verified):
 *   cwd  /Users/jeremy/.agentproto/worktrees/ts/gc-fresh-hold
 *   →    -Users-jeremy--agentproto-worktrees-ts-gc-fresh-hold
 *   (note the "--" from "/." — one dash for "/", one for ".", not collapsed)
 *
 *   cwd  /Volumes/SSDExternalMacStudio/Code/_agentproto-worktrees/adapter-claude-sdk
 *   →    -Volumes-SSDExternalMacStudio-Code--agentproto-worktrees-adapter-claude-sdk
 *   (same double-dash shape, this time from "/_")
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-")
}

/** Exported so `conversation-index.ts` can resolve the same directory
 *  without re-deriving the slug rule itself. */
export function claudeCodeProjectDir(cwd: string): string {
  return resolve(homedir(), ".claude", "projects", claudeProjectSlug(cwd))
}

function extractFirstText(content: unknown): string | undefined {
  if (typeof content === "string") {
    const t = content.trim()
    return t || undefined
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        const t = ((block as { text: string }).text).trim()
        if (t) return t
      }
    }
  }
  return undefined
}

/** Light line-scan for candidate metadata — NOT the full transcript parser
 *  (that's exportClaudeCodeSession). Streams the file so large jsonl files
 *  don't get pulled fully into memory. */
async function scanClaudeJsonl(filePath: string): Promise<{
  startedAt?: string
  lastActivityAt?: string
  messageCount: number
  preview?: string
  lastWriter?: string
}> {
  const stream = createReadStream(filePath, { encoding: "utf8" })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })

  let startedAt: string | undefined
  let lastActivityAt: string | undefined
  let messageCount = 0
  let preview: string | undefined
  let lastWriter: string | undefined

  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: ClaudeJsonlMeta
    try {
      entry = JSON.parse(trimmed) as ClaudeJsonlMeta
    } catch {
      continue
    }

    if (typeof entry.timestamp === "string") {
      if (!startedAt) startedAt = entry.timestamp
      lastActivityAt = entry.timestamp
    }
    if (typeof entry.entrypoint === "string") {
      lastWriter = entry.entrypoint
    }
    if (entry.type === "user" || entry.type === "assistant") {
      messageCount += 1
      if (preview === undefined && entry.type === "user") {
        const text = extractFirstText(entry.message?.content)
        if (text !== undefined) {
          preview = text.length > 120 ? text.slice(0, 120) : text
        }
      }
    }
  }

  return { startedAt, lastActivityAt, messageCount, preview, lastWriter }
}

async function buildClaudeCandidate(
  filePath: string,
  conversationId: string,
): Promise<ConversationCandidate> {
  const scanned = await scanClaudeJsonl(filePath)
  return { conversationId, ...scanned }
}

/** Maps an abstract `attachmentMode` to claude's own jsonl `entrypoint`
 *  vocabulary. Kept local to this store — callers deal only in
 *  `"native" | "acp"`, never `"cli" | "sdk-ts"`. */
function claudeEntrypointFor(mode: "native" | "acp"): string {
  return mode === "native" ? "cli" : "sdk-ts"
}

async function discoverClaudeCode(input: DiscoverInput): Promise<ConversationCandidate[]> {
  const { cwd, since, until, attachmentMode, expectedId } = input
  const dir = claudeCodeProjectDir(cwd)

  // Ground truth beats heuristic: bind to exactly the conversation we were
  // asked about, never whichever transcript happens to be newest. Never
  // falls through to the mtime path below — see invariants.
  if (expectedId) {
    const filePath = join(dir, `${expectedId}.jsonl`)
    try {
      await fs.stat(filePath)
    } catch {
      return []
    }
    return [await buildClaudeCandidate(filePath, expectedId)]
  }

  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }
  const jsonlFiles = entries.filter(e => e.endsWith(".jsonl"))
  if (jsonlFiles.length === 0) return []

  const sinceMs = since ? Date.parse(since) : NaN
  const untilMs = until ? Date.parse(until) : NaN
  const wantEntrypoint = attachmentMode ? claudeEntrypointFor(attachmentMode) : undefined
  const scored: { candidate: ConversationCandidate; mtimeMs: number }[] = []
  for (const f of jsonlFiles) {
    const filePath = join(dir, f)
    let mtimeMs: number
    try {
      mtimeMs = (await fs.stat(filePath)).mtimeMs
    } catch {
      continue
    }
    if (Number.isFinite(sinceMs) && mtimeMs < sinceMs - 1000) continue
    const conversationId = f.replace(/\.jsonl$/, "")
    const candidate = await buildClaudeCandidate(filePath, conversationId)
    // `until` is an upper bound on the conversation's own first message —
    // provably not this session's if it started after the session ended.
    // Conservative: no discoverable startedAt ⇒ never dropped.
    if (Number.isFinite(untilMs) && candidate.startedAt !== undefined) {
      const startedMs = Date.parse(candidate.startedAt)
      if (Number.isFinite(startedMs) && startedMs > untilMs) continue
    }
    // Attachment-mode match: a native PTY's conversation is never written
    // by the ACP arm and vice versa. Conservative: no lastWriter ⇒ never
    // dropped, and an unset attachmentMode applies no filtering at all.
    if (wantEntrypoint !== undefined && candidate.lastWriter !== undefined && candidate.lastWriter !== wantEntrypoint) {
      continue
    }
    scored.push({ candidate, mtimeMs })
  }

  // Newest first — mirrors the old fsProbe's mtime-desc pick, and gives
  // callers of `discover` (which may just want "the likely one") a sane
  // default ordering without silently collapsing the list.
  scored.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return scored.map(s => s.candidate)
}

async function readClaudeCode(conversationId: string, cwd?: string): Promise<ExportedSession> {
  // Dynamic import, not a top-level one: resume-strategies.ts is its own
  // lean tsup entry (splitting:false) and pulls this module in as a value
  // import via CONVERSATION_STORES. esbuild still bundles transcript-
  // export.ts's bytes into that entry either way (no code-splitting means
  // no separate chunk to defer to) — what the dynamic import buys is
  // deferred MODULE INIT: transcript-export.ts's top-level code only runs
  // the first time `read()` is actually called, not merely by importing
  // resume-strategies.ts. See resume-strategies.ts's splitting:false note.
  const { exportClaudeCodeSession } = await import("./transcript-export.js")
  return exportClaudeCodeSession(conversationId, cwd)
}

// ── hermes store ────────────────────────────────────────────────────
//
// Native store: ~/.hermes/state.db, a sqlite `sessions` table keyed by
// `id` (the agentproto UUID passed as resumeSessionId — the same id
// agentproto records as `adapterSessionId`, unlike claude-code's on-disk
// jsonl uuid). It has a `cwd` column (live-verified 2026-07-17), so
// cwd-scoped discovery is possible, unlike a plain folder-of-files store.

async function discoverHermes(input: DiscoverInput): Promise<ConversationCandidate[]> {
  // Dynamic import, not a top-level one — same reasoning as readClaudeCode
  // above: keeps transcript-export.ts's sqlite plumbing out of
  // resume-strategies.ts's lean tsup entry until a hermes store method
  // actually runs.
  const { discoverHermesSessions } = await import("./transcript-export.js")
  return discoverHermesSessions(input.cwd, input.since, input.expectedId)
}

async function readHermes(conversationId: string): Promise<ExportedSession> {
  const { exportHermesSession } = await import("./transcript-export.js")
  return exportHermesSession(conversationId)
}

export const CONVERSATION_STORES: Record<string, ConversationStore> = {
  "claude-code": {
    storeAs: "claudeResumeId",
    // Printed by claude on graceful exit when session persistence is on
    // (default). Example: `claude --resume 0e483f81-1a44-4bec-9667-b37158450296`
    outputHint: /claude\s+--resume\s+([0-9a-f-]{8,})/i,
    attachArgv: (conversationId: string) => ["claude", "--resume", conversationId],
    discover: discoverClaudeCode,
    read: readClaudeCode,
  },
  hermes: {
    storeAs: "hermesResumeId",
    // `hermes acp` is the ACP arm (bin_args in adapters/hermes/src/index.ts);
    // `--resume SESSION --tui` is the native TUI resume path — same binary,
    // different flags, unlike claude-code where the two arms are different
    // binaries. Verified via `hermes --help`: `--resume SESSION, -r` =
    // "Resume a previous session by ID or title", `--tui` = the real TUI.
    attachArgv: (conversationId: string) => ["hermes", "--resume", conversationId, "--tui"],
    discover: discoverHermes,
    read: readHermes,
  },
}
