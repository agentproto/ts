/**
 * The "one owner per PR or branch" lock for `agent_start`.
 *
 * A session can declare an {@link SpawnAgentSessionInput.ownerKey} — a
 * canonical `pr:<repo>#<n>` or `branch:<name>` — and the daemon refuses a
 * second spawn that names the same key while the first owner is either still
 * live or was stopped/reaped less than {@link OWNER_LOCK_TTL_MS} ago. This is
 * deliberately a HARD refusal that names the owner (not a silent redirect):
 * two agents mutating one PR/branch is the failure this prevents, and a
 * caller that genuinely wants to take over says so explicitly with
 * `takeOver: true`.
 *
 * Matching uses the descriptor `meta.ownerKey` stamped at spawn time, so the
 * lock survives a daemon restart and still sees reaped rows (the idle reaper
 * keeps the row, it only ends the process). The pure functions here are kept
 * separate from `session-spawn.ts` for the same reason `spawn-dedupe.ts` is:
 * the key canonicalisation and the conflict rule are worth testing without a
 * registry or a filesystem.
 */

/** Descriptor `meta` key carrying the canonical owner key. */
export const OWNER_KEY_META = "ownerKey"

/** How long a stopped/reaped owner keeps its key reserved. 24h: long enough
 *  that a parked PR isn't silently taken by a fresh spawn the same day,
 *  short enough that yesterday's finished work doesn't wedge the key
 *  forever. An explicit `takeOver: true` always wins inside the window. */
export const OWNER_LOCK_TTL_MS = 24 * 60 * 60 * 1000

export type NormalizeOwnerKeyResult =
  | { ok: true; key: string }
  | { ok: false; reason: string }

const PR_REPO_PREFIXES = [
  "https://github.com/",
  "http://github.com/",
  "git://github.com/",
  "ssh://git@github.com/",
  "git@github.com:",
  "www.github.com/",
  "github.com/",
]

/**
 * Canonicalise an `ownerKey` to `pr:<owner>/<repo>#<n>` or
 * `branch:<name>`.
 *
 * PR keys are case/format tolerant on purpose — `PR:Agentik-Studio/
 * Agentik-Studio#01440`, `https://github.com/agentik-studio/agentik-studio.git#1440`
 * and `pr:agentik-studio/agentik-studio#1440` all canonicalise to the same
 * key, so a key derived by a brain label and one typed by a human can never
 * name the same PR differently. Branch names are case-SENSITIVE (git treats
 * them that way) and only have their `refs/heads/` prefix and surrounding
 * whitespace stripped.
 *
 * Returns `{ ok: false }` with a human-readable reason for a key that isn't
 * of either shape — the spawn path turns that into `owner_key_invalid`.
 */
export function normalizeOwnerKey(raw: string): NormalizeOwnerKeyResult {
  const trimmed = raw.trim()
  const prMatch = /^pr:/i.exec(trimmed)
  if (prMatch) {
    const rest = trimmed.slice(prMatch[0].length)
    const hash = rest.lastIndexOf("#")
    if (hash < 0) {
      return { ok: false, reason: `ownerKey "${raw}" is malformed: expected "pr:<owner>/<repo>#<number>"` }
    }
    const repo = normalizeRepo(rest.slice(0, hash))
    const numberRaw = rest.slice(hash + 1).trim()
    if (!repo) {
      return { ok: false, reason: `ownerKey "${raw}" is malformed: expected "pr:<owner>/<repo>#<number>"` }
    }
    if (!/^\d+$/.test(numberRaw)) {
      return { ok: false, reason: `ownerKey "${raw}" is malformed: PR number must be a positive integer` }
    }
    const number = Number.parseInt(numberRaw, 10)
    if (!Number.isSafeInteger(number) || number <= 0) {
      return { ok: false, reason: `ownerKey "${raw}" is malformed: PR number must be a positive integer` }
    }
    return { ok: true, key: `pr:${repo}#${number}` }
  }

  const branchMatch = /^branch:/i.exec(trimmed)
  if (branchMatch) {
    let name = trimmed.slice(branchMatch[0].length).trim()
    if (name.startsWith("refs/heads/")) name = name.slice("refs/heads/".length)
    name = name.trim()
    if (!name) {
      return { ok: false, reason: `ownerKey "${raw}" is malformed: branch name is empty` }
    }
    if (/\s/.test(name)) {
      return { ok: false, reason: `ownerKey "${raw}" is malformed: branch name may not contain whitespace` }
    }
    return { ok: true, key: `branch:${name}` }
  }

  return {
    ok: false,
    reason: `ownerKey "${raw}" is malformed: expected "pr:<owner>/<repo>#<number>" or "branch:<name>"`,
  }
}

/** Lowercase a GitHub repo slug and strip any scheme/host prefix, trailing
 *  slash and `.git` suffix. Returns `undefined` when what remains isn't a
 *  plausible `<owner>/<repo>` slug. */
function normalizeRepo(raw: string): string | undefined {
  let repo = raw.trim()
  for (const prefix of PR_REPO_PREFIXES) {
    if (repo.toLowerCase().startsWith(prefix)) {
      repo = repo.slice(prefix.length)
      break
    }
  }
  repo = repo.replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase()
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo)) return undefined
  return repo
}

/** The subset of a descriptor the lock reads. Kept structural so the rule is
 *  testable without constructing a full `SessionDescriptor`. */
export interface OwnerLockSession {
  id: string
  status?: string
  /** Read-time liveness projection (`SessionDescriptor.alive`). Preferred
   *  over `status` when present because a terminal row can still report a
   *  stale `status`. */
  alive?: boolean
  endedAt?: string
  meta?: Record<string, string>
}

/**
 * Return the session that currently owns `key`, or `undefined` when the key
 * is free. A session owns it when its `meta.ownerKey` matches and either:
 *
 *   - it is live (`alive`, or a `running`/`starting` status), or
 *   - it ended less than `ttlMs` ago — stopped, reaped, crashed, whatever;
 *     the point is that the work it was doing may still be in flight.
 *
 * `now` is passed in rather than read from the clock so the 24h boundary is
 * deterministic under test.
 */
export function findOwnerConflict(
  sessions: readonly OwnerLockSession[],
  key: string,
  now: number,
  ttlMs: number = OWNER_LOCK_TTL_MS,
): OwnerLockSession | undefined {
  for (const session of sessions) {
    if (session.meta?.[OWNER_KEY_META] !== key) continue
    if (isLive(session)) return session
    if (session.endedAt) {
      const endedMs = Date.parse(session.endedAt)
      if (Number.isFinite(endedMs) && now - endedMs < ttlMs) return session
    }
  }
  return undefined
}

function isLive(session: OwnerLockSession): boolean {
  if (session.alive !== undefined) return session.alive
  return session.status === "running" || session.status === "starting"
}
