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

import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/** Where on disk the resume id ends up on the session descriptor. */
export type ResumeMetadataKey =
  | "claudeResumeId"
  | "hermesResumeId"
  | "codexResumeId"
  | "openClawResumeId"
  | "openCodeResumeId"

export interface ResumeStrategy {
  /** When set, run on every output line for this adapter. Group 1
   *  captures the resume id. The match is saved on the descriptor
   *  as `resumeMetadata[storeAs]`. */
  outputHint?: RegExp
  /** Where the matched id is recorded on the descriptor. */
  storeAs: ResumeMetadataKey
  /** Probe the adapter's on-disk session store for the most-recently
   *  modified session in the given workspace. Returns the resume id
   *  or null when nothing eligible. Files older than `prevStartedAt`
   *  are ignored (avoids resuming an unrelated prior conversation).
   *
   *  Skip when the adapter doesn't persist sessions externally. */
  fsProbe?(cwd: string, prevStartedAt: string): Promise<string | null>
  /** Return the argv to spawn a PTY that resumes into the given id.
   *  When omitted, the daemon falls back to ACP-level resume via
   *  the agent-cli protocol instead of the provider's native CLI. */
  spawnArgs?(id: string): string[]
}

export const RESUME_STRATEGIES: Record<string, ResumeStrategy> = {
  "claude-code": {
    // Printed by claude on graceful exit when session persistence
    // is on (default). Example: `claude --resume 0e483f81-1a44-4bec-9667-b37158450296`
    outputHint: /claude\s+--resume\s+([0-9a-f-]{8,})/i,
    storeAs: "claudeResumeId",
    fsProbe: probeMtimeLatestJsonl(".claude/projects"),
    spawnArgs: id => ["claude", "--resume", id],
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
 * Build an `fsProbe` for adapters that store one `.jsonl` per session
 * inside `~/<storeRel>/<cwd-encoded>/`. The encoded cwd is the
 * absolute path with `/` → `-` (claude's convention; others tend to
 * use the same scheme). Returns the UUID of the most-recently
 * modified `.jsonl`, filtered to files at-or-after `prevStartedAt`.
 */
function probeMtimeLatestJsonl(
  storeRel: string,
): (cwd: string, prevStartedAt: string) => Promise<string | null> {
  return async (cwd, prevStartedAt) => {
    const encoded = cwd.replace(/\//g, "-")
    const dir = resolve(homedir(), storeRel, encoded)
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      return null
    }
    const jsonl = entries.filter(e => e.endsWith(".jsonl"))
    if (jsonl.length === 0) return null
    const startedAtMs = Date.parse(prevStartedAt)
    const candidates: { name: string; mtime: number }[] = []
    for (const f of jsonl) {
      try {
        const st = await fs.stat(join(dir, f))
        if (!Number.isFinite(startedAtMs) || st.mtimeMs >= startedAtMs - 1000) {
          candidates.push({ name: f, mtime: st.mtimeMs })
        }
      } catch {
        // ignore unreadable entry
      }
    }
    if (candidates.length === 0) return null
    candidates.sort((a, b) => b.mtime - a.mtime)
    return candidates[0]!.name.replace(/\.jsonl$/, "")
  }
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
  const id = await strategy.fsProbe(prev.cwd, prev.startedAt)
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
