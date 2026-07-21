/**
 * Per-adapter resume strategies — the daemon's view of "how do I
 * continue a previous session for THIS adapter?".
 *
 * The driver already has an `AgentCliContinuation` declaration in
 * the adapter manifest (AIP-45). That covers strategy NAMES
 * (`native-resume`, `pinned-session`, `transcript`, `none`) but is
 * silent on the mechanics that live OUTSIDE the runtime — like
 * "where on disk does this adapter store its conversations?" or
 * "what argv do I pass to resume into PTY mode?".
 *
 * This table is that practical bridge. Each entry declares three
 * optional hooks:
 *
 *   outputHint   regex matched against each output line; group 1 is
 *                the resume id. Stored as `desc.resumeMetadata[storeAs]`.
 *   fsProbe      async function that probes a per-adapter directory
 *                for a stored session id, scoped to a workspace cwd.
 *                Used when `outputHint` never matched.
 *   spawnArgs    given a captured id, returns the argv to spawn a
 *                PTY that resumes the session. agentproto then
 *                bypasses ACP/agent-cli and runs the provider
 *                directly — the most reliable resume path because
 *                it leans on the provider's native UX.
 *
 * Adapters that don't declare anything here fall back to:
 *   1. ACP-level resume via `resumeSessionId` on POST /sessions/agent
 *   2. Fresh spawn (same shape, no continuity)
 *
 * Eventually each adapter should ship its own strategy on
 * `AgentCliHandle.resumeStrategy` (driver-side). This central table
 * is the bootstrap: it lets a new adapter become resume-capable
 * without bumping its npm package; once that lands, entries
 * graduate into the adapter packages.
 */

import { CONVERSATION_STORES } from "./conversation-store.js"

/** Where on disk the resume id ends up on the session descriptor. */
export type ResumeMetadataKey =
  | "claudeResumeId"
  | "hermesResumeId"
  | "codexResumeId"
  | "openClawResumeId"
  | "openCodeResumeId"
  // Export/read-only stores (no native resume wired): the key labels the
  // conversation store entry in CONVERSATION_STORES but is never written to
  // a descriptor's resumeMetadata, since these have no attachArgv/outputHint.
  | "mastracodeInprocessResumeId"
  | "piResumeId"

export interface ResumeStrategy {
  /** When set, run on every output line for this adapter. Group 1
   *  captures the resume id. The match is saved on the descriptor
   *  as `resumeMetadata[storeAs]`. */
  outputHint?: RegExp
  /** Where the matched id is recorded on the descriptor. */
  storeAs: ResumeMetadataKey
  /** Probe the adapter's on-disk session store for the resume id of a
   *  session in the given workspace. Returns the id or null when nothing
   *  eligible.
   *
   *  When `expectedId` is set the session's own conversation id is known
   *  (agent-cli descriptors carry it as `adapterSessionId`; for
   *  claude-code it IS the on-disk `.jsonl` uuid — see acp-host.ts) and
   *  the probe MUST bind to exactly that transcript: it confirms
   *  `<expectedId>` exists and returns it, else null. It never falls
   *  through to a mtime guess in that case — resuming *some other*
   *  session that merely shares the cwd is a silent cross-session
   *  correctness bug, strictly worse than not resuming at all.
   *
   *  Only when `expectedId` is absent (e.g. a raw PTY claude session that
   *  never had an ACP session id) does the probe fall back to
   *  most-recently-modified, filtered to files at-or-after `prevStartedAt`
   *  (avoids resuming an unrelated prior conversation).
   *
   *  Skip when the adapter doesn't persist sessions externally. */
  fsProbe?(
    cwd: string,
    prevStartedAt: string,
    expectedId?: string,
  ): Promise<string | null>
  /** Return the argv to spawn a PTY that resumes into the given id.
   *  When omitted, the daemon falls back to ACP-level resume via
   *  the agent-cli protocol instead of the provider's native CLI. */
  spawnArgs?(id: string): string[]
}

// claude-code's entry is PROJECTED from `CONVERSATION_STORES` (conversation-
// store.ts) rather than declared standalone, so this table and the
// conversation store can never drift apart again. `fsProbe` adapts the old
// (cwd, prevStartedAt, expectedId) => id|null shape onto `store.discover`:
// with an expectedId it's the single bound candidate (or none); without one
// it's the newest candidate in `discover`'s mtime-desc order (or none) —
// byte-for-byte the same answers the old mtime-latest probe gave.
const claudeCodeStore = CONVERSATION_STORES["claude-code"]!

export const RESUME_STRATEGIES: Record<string, ResumeStrategy> = {
  "claude-code": {
    outputHint: claudeCodeStore.outputHint,
    storeAs: claudeCodeStore.storeAs,
    fsProbe: async (cwd, prevStartedAt, expectedId) => {
      const candidates = await claudeCodeStore.discover({
        cwd,
        since: prevStartedAt,
        expectedId,
      })
      return candidates[0]?.conversationId ?? null
    },
    spawnArgs: claudeCodeStore.attachArgv,
  },

  // Stubs for other shipped adapters — fill in as we learn each
  // provider's resume mechanism. Today they fall back to ACP-level
  // resume (whatever the agent-cli runtime supports) or fresh spawn.
  //
  //   hermes: { storeAs: "hermesResumeId", ... }
  //   codex: { storeAs: "codexResumeId", ... }
  //   openclaw: { storeAs: "openClawResumeId", ... }
  //   opencode: { storeAs: "openCodeResumeId", ... }
}

/**
 * Helper: which adapters declare any resume capability? Used by
 * `agentproto sessions restart` to print a helpful "this adapter
 * doesn't support resume; falling back to fresh spawn" hint when
 * applicable.
 */
export function hasResumeStrategy(adapterSlug: string | undefined): boolean {
  if (!adapterSlug) return false
  const s = RESUME_STRATEGIES[adapterSlug]
  return !!(s && (s.outputHint || s.fsProbe || s.spawnArgs))
}

// ── Restart decision tree ────────────────────────────────────────
//
// Shared between the CLI (`agentproto sessions restart`, sessions.ts)
// and the daemon's `session_restart` MCP tool (session-tools.ts) —
// both need to answer "given this dead/alive session, how do I bring
// it back with the most continuity?" the exact same way. Duck-typed
// on a minimal shape rather than importing `SessionDescriptor` from
// sessions.ts: this file is its own tsup entry (`splitting: false`),
// so a value-level cross-entry import would inline the whole sessions
// module here. A full `SessionDescriptor` satisfies these structurally.

export interface RestartCandidate {
  adapterSlug?: string
  resumeMetadata?: Record<string, string>
  pty?: boolean
  adapterSessionId?: string
}

export interface FsProbeCandidate extends RestartCandidate {
  cwd?: string
  startedAt: string
}

/**
 * Where a restart should land. Computed once so callers never diverge:
 *
 *   1. pty-native  — the adapter has a captured resume id AND declares
 *      `spawnArgs` (e.g. claude-code): respawn a PTY running the
 *      provider's own resume command. Most reliable — works whenever
 *      the provider persisted the session, regardless of whether the
 *      ACP wrapper did.
 *   2. pty-plain   — the previous session was a real PTY with no
 *      native strategy match: re-run the same argv, no continuity.
 *   3. agent       — an agent-cli session with no native strategy:
 *      resume at the ACP level via the adapter's own session id (may
 *      still 404 if the adapter never persisted a turn — callers
 *      should retry without `resumeSessionId` on a "not found" error).
 *   4. unsupported — a generic command session; no history to resume
 *      and no shape to clone reliably.
 */
export type RestartStrategy =
  | { kind: "pty-native"; argv: string[] }
  | { kind: "pty-plain" }
  | { kind: "agent"; resumeSessionId?: string }
  | { kind: "unsupported"; reason: string }

export function decideRestartStrategy(prev: RestartCandidate): RestartStrategy {
  // Provider-native resume takes precedence over ACP-level resume —
  // strictly more reliable when available.
  if (prev.adapterSlug) {
    const strategy = RESUME_STRATEGIES[prev.adapterSlug]
    const id = strategy?.storeAs
      ? prev.resumeMetadata?.[strategy.storeAs]
      : undefined
    if (strategy?.spawnArgs && id) {
      return { kind: "pty-native", argv: strategy.spawnArgs(id) }
    }
  }
  if (prev.pty === true) {
    return { kind: "pty-plain" }
  }
  if (prev.adapterSlug) {
    return {
      kind: "agent",
      ...(prev.adapterSessionId
        ? { resumeSessionId: prev.adapterSessionId }
        : {}),
    }
  }
  return {
    kind: "unsupported",
    reason: "generic command session — restart only supports pty + agent-cli",
  }
}

/**
 * Generic filesystem-fallback: for each known adapter strategy that
 * defines an `fsProbe`, run it against this session's cwd. If a
 * resume id is found, attach it to the descriptor's resumeMetadata.
 *
 * Lets `restart` recover continuity even when our own output sniffer
 * missed the resume hint (session killed too quickly, output buffered
 * past the kill, …). Eligible only when the file is at-or-after the
 * session's `startedAt` (avoid resuming an unrelated prior session
 * in the same cwd — see ResumeStrategy.fsProbe comment).
 */
export async function augmentWithFsResume<T extends FsProbeCandidate>(
  prev: T,
): Promise<T> {
  const slug = prev.adapterSlug
  if (!slug) return prev
  const strategy = RESUME_STRATEGIES[slug]
  if (!strategy?.fsProbe) return prev
  // If we already have a captured id for this strategy's storage key,
  // skip the FS probe — the sniffer found it during the session.
  if (prev.resumeMetadata?.[strategy.storeAs]) return prev
  if (!prev.cwd) return prev
  // Pass the session's own conversation id (agent-cli sets it as
  // `adapterSessionId`; for claude-code it equals the on-disk `.jsonl`
  // uuid — acp-host.ts pins them equal) so the probe binds to THIS
  // session's transcript instead of the newest one in the cwd. Without
  // it, a restart of a session that shares a cwd with a concurrent one
  // could silently resume the wrong conversation.
  const id = await strategy.fsProbe(
    prev.cwd,
    prev.startedAt,
    prev.adapterSessionId,
  )
  if (!id) return prev
  return {
    ...prev,
    resumeMetadata: {
      ...(prev.resumeMetadata ?? {}),
      [strategy.storeAs]: id,
    },
  }
}

/**
 * Describe which resume path a restart used, for CLI banners / MCP
 * responses. Returns a short phrase like "resumed via claude --resume",
 * or "resumed via ACP", or "" when no resume was attempted.
 */
export function describeResumePath(prev: RestartCandidate): string {
  if (prev.adapterSlug) {
    const s = RESUME_STRATEGIES[prev.adapterSlug]
    if (s?.spawnArgs && s.storeAs && prev.resumeMetadata?.[s.storeAs]) {
      const sample = s.spawnArgs("…")[0] ?? prev.adapterSlug
      return `resumed via ${sample} --resume`
    }
  }
  if (prev.adapterSlug && prev.adapterSessionId) {
    return "resumed via ACP"
  }
  return ""
}

/**
 * Shell-style argv tokenizer for descriptors that don't carry `argv`
 * separately (legacy persisted rows predating that field). Same rules
 * as the spawn-dialog tokenizer in the web app: whitespace splits,
 * single + double quotes group.
 */
export function tokenizeCommand(s: string): string[] {
  const out: string[] = []
  let buf = ""
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }
    if (!inSingle && !inDouble && /\s/.test(ch ?? "")) {
      if (buf) {
        out.push(buf)
        buf = ""
      }
      continue
    }
    buf += ch
  }
  if (buf) out.push(buf)
  return out
}
