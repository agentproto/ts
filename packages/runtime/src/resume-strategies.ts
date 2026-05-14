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
