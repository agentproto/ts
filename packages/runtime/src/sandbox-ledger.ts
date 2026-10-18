/**
 * The sandbox ledger — `~/.agentproto/sandboxes.json`.
 *
 * The daemon KNOWS when it boots, pauses, reconnects to, or stops a sandbox
 * box (AIP-36 boot-and-drive, `session-spawn.ts`'s `bootSandboxAgentSession`
 * and the lifecycle teardown inside `SandboxAgentSessionProxy.close()`), but
 * it writes none of it down: finding a still-live sandboxId meant grepping
 * session descriptors for a `remote: true` stamp. This module is the
 * navigation half — one durable record per sandboxId:
 *
 *   { sandboxId, provider, label?, state, cwd?, originSessionId?,
 *     createdAt, updatedAt, expiresAt? }
 *
 * State machine: "booted" (fresh boot) → "connected" (reuse/attach) →
 * "paused" (proxy close() chose the pause teardown) | "stopped" (kill or
 * expiry). `expiresAt` is stamped at boot when the spec's lifecycle policy
 * carries a known idle window (`lifecycle.pause_after_idle` →
 * `SandboxLifecyclePolicy.pauseAfterIdleMs`) — the one expiry the daemon
 * actually knows about at boot time; a provider-side TTL the daemon never
 * sees is deliberately NOT guessed at here.
 *
 * Writes are ALWAYS best-effort: every helper swallows its own failures and
 * returns without throwing. A ledger error must never fail a spawn, a
 * pause, or a teardown — the ledger is an index over reality, never a
 * participant in it.
 *
 * Persistence style matches the daemon's other JSON stores
 * (`workspace-buckets.ts`, `saveWorkspacesConfig`): serialize → write to a
 * per-process-unique tmp file → rename over the target. A concurrent reader
 * never sees half a JSON object, and two in-flight writers never share a
 * tmp path (the pid-only suffix is not unique within one process — see the
 * 2026-08-14 registry-wipe write-up in `workspace-buckets.ts`).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/** Lifecycle states a ledger row can carry. `"gone"` is stamped when the
 *  PROVIDER answers the box no longer exists (liveness probe 404 / a
 *  reconnect failing with the provider's not-found error) — distinct from
 *  `"stopped"` (WE tore it down) and from `"paused"` (the last thing WE
 *  did, which a vanished box makes a lie). */
export type SandboxLedgerState = "booted" | "paused" | "connected" | "stopped" | "gone"

/* AIP-36 amendment "shared box" — one box can host SEVERAL live sessions
 * (e.g. two agents attaching to the same e2b sandbox via `reuse`). The
 * ledger is the refcount: `attachedSessions` lists every session currently
 * attached, which makes a daemon restart robust (the count lives on disk,
 * not in memory). Session teardown = DETACH: the box is only stopped when
 * the LAST session detaches — stopping the first of two sessions must never
 * kill the box under the surviving one's feet. */
export interface SandboxLedgerEntry {
  sandboxId: string
  provider: string
  state: SandboxLedgerState
  createdAt: string
  updatedAt: string
  label?: string
  cwd?: string
  /** The workspace whose git token this box was booted with
   *  (`AGENTPROTO_GIT_TOKEN` sits in the box env for the box's whole life). A
   *  `reuse` from any other workspace is refused so it cannot inherit it. */
  gitTokenWorkspace?: string
  /** The HOST session id that first booted / last reconnected to the box. */
  originSessionId?: string
  /** Every session CURRENTLY attached to this box (AIP-36 shared-box
   *  amendment). Written by `recordSandboxBoot` / `recordSandboxOrigin`,
   *  dropped per-session by `recordSessionDetach`. The refcount source of
   *  truth — on disk, so it survives a daemon restart.
   *
   *  Known follow-up (scoped, not fixed in this PR): a session that dies
   *  WITHOUT going through `close()` (daemon SIGKILL / crash) leaves a
   *  stale attaché here — the box's real last session never triggers the
   *  teardown and `sandbox gc` conservatively skips the box forever. A
   *  restart-time sweep reconciling `attachedSessions` against the live
   *  session registry should prune dead ids. */
  attachedSessions?: string[]
  /** ISO instant the box is expected to idle-expire — stamped only when the
   *  boot knew a window (`lifecycle.pause_after_idle`). */
  expiresAt?: string
  /** Set when the box was torn down because its session was idle-reaped
   *  (`daemon.sandboxIdleReapAfterMs`) rather than closed by a user: the ISO
   *  instant, how long the session had been idle, and the host session id.
   *  Cleared by the next boot/reconnect of the same sandboxId. */
  reapedAt?: string
  reapedIdleMs?: number
  reapedSessionId?: string
  /** Last PROVIDER liveness probe verdict (`SandboxProvider.probe`) — the
   *  only signal that distinguishes box death from session death. Absent
   *  when never probed (or the provider can't probe): the ledger's `state`
   *  alone is NOT trustworthy — a dead box looks paused until probed. */
  sandboxAlive?: boolean
  /** ISO instant `sandboxAlive` was computed. */
  sandboxCheckedAt?: string
}

export interface SandboxLedgerSnapshot {
  savedAt: string
  sandboxes: SandboxLedgerEntry[]
}

/** `~/.agentproto/sandboxes.json`. `AGENTPROTO_SANDBOX_LEDGER` overrides
 *  the path (tests, and a caller that wants a workspace-scoped ledger). */
export const sandboxLedgerPath = (): string =>
  process.env.AGENTPROTO_SANDBOX_LEDGER ??
  resolve(homedir(), ".agentproto", "sandboxes.json")

/** Monotonic per-process tmp suffix — same rationale as
 *  `workspace-buckets.ts`'s `tmpSeq` (pid alone is NOT unique within one
 *  process; two interleaved writers sharing a tmp path promote a truncated
 *  file). */
let tmpSeq = 0

const serialize = (snapshot: SandboxLedgerSnapshot): string =>
  JSON.stringify(snapshot, null, 2) + "\n"

const isLedgerState = (value: unknown): value is SandboxLedgerState =>
  value === "booted" ||
  value === "paused" ||
  value === "connected" ||
  value === "stopped" ||
  value === "gone"

const isEntry = (value: unknown): value is SandboxLedgerEntry => {
  if (typeof value !== "object" || value === null) return false
  if (
    !("sandboxId" in value) ||
    !("provider" in value) ||
    !("state" in value) ||
    !("createdAt" in value) ||
    !("updatedAt" in value)
  ) {
    return false
  }
  return (
    typeof value.sandboxId === "string" &&
    value.sandboxId.length > 0 &&
    typeof value.provider === "string" &&
    isLedgerState(value.state) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  )
}

/** Rows currently on disk. `[]` for a missing/corrupt file — the same
 *  "degrade to nothing rather than throw" contract as every other store
 *  reader in this daemon. Never throws. */
export function readSandboxLedger(path?: string): SandboxLedgerEntry[] {
  try {
    const parsed: { sandboxes?: unknown } = JSON.parse(
      readFileSync(path ?? sandboxLedgerPath(), "utf8"),
    )
    if (!Array.isArray(parsed.sandboxes)) return []
    return parsed.sandboxes.filter(isEntry)
  } catch {
    return []
  }
}

/**
 * Upsert (dedup by `sandboxId`) and persist. Sync + best-effort: the
 * lifecycle hooks that call this run inside teardown/finally paths where
 * Node won't await, and a failure here is a lost index row, never a lost
 * box. Swallows every error.
 */
export function upsertSandboxLedger(entry: SandboxLedgerEntry, path?: string): void {
  try {
    const target = path ?? sandboxLedgerPath()
    const dir = join(target, "..")
    mkdirSync(dir, { recursive: true })
    const existing = readSandboxLedger(target)
    const merged = [entry, ...existing.filter(e => e.sandboxId !== entry.sandboxId)]
    const snapshot: SandboxLedgerSnapshot = {
      savedAt: new Date().toISOString(),
      sandboxes: merged,
    }
    const tmp = `${target}.tmp.${process.pid}.${++tmpSeq}`
    writeFileSync(tmp, serialize(snapshot), "utf8")
    renameSync(tmp, target)
  } catch {
    // Best-effort, always — see module doc.
  }
}

/** Remove a row by sandboxId. Returns whether a row was actually dropped
 *  (read from the PRE-call disk state). Never throws. */
export function removeSandboxLedgerEntry(sandboxId: string, path?: string): boolean {
  try {
    const target = path ?? sandboxLedgerPath()
    const existing = readSandboxLedger(target)
    if (!existing.some(e => e.sandboxId === sandboxId)) return false
    const snapshot: SandboxLedgerSnapshot = {
      savedAt: new Date().toISOString(),
      sandboxes: existing.filter(e => e.sandboxId !== sandboxId),
    }
    const tmp = `${target}.tmp.${process.pid}.${++tmpSeq}`
    writeFileSync(tmp, serialize(snapshot), "utf8")
    renameSync(tmp, target)
    return true
  } catch {
    return false
  }
}

const nowIso = (): string => new Date().toISOString()

/** Append `sessionId` to an attached-sessions list (dedupe, keep order). */
const attachToSessions = (
  prior: string[] | undefined,
  sessionId: string | undefined,
): string[] => {
  if (!sessionId) return prior ?? []
  return prior?.includes(sessionId) ? prior : [...(prior ?? []), sessionId]
}

/**
 * Stamp a boot or reconnect into the ledger — the spawn path's hook.
 * `state` is "booted" for a fresh boot, "connected" for a reuse/attach.
 * Best-effort: never throws, whatever happens.
 */
export function recordSandboxBoot(opts: {
  sandboxId: string
  provider: string
  state: "booted" | "connected"
  label?: string
  cwd?: string
  originSessionId?: string
  expiresAt?: string
  gitTokenWorkspace?: string
  /** The host session attaching to the box — appended to the shared-box
   *  refcount (`attachedSessions`) in the same write. */
  sessionId?: string
  path?: string
}): void {
  try {
    const target = opts.path ?? sandboxLedgerPath()
    const existing = readSandboxLedger(target)
    const prior = existing.find(e => e.sandboxId === opts.sandboxId)
    const attached = attachToSessions(prior?.attachedSessions, opts.sessionId)
    const ts = nowIso()
    const entry: SandboxLedgerEntry = {
      sandboxId: opts.sandboxId,
      provider: opts.provider,
      state: opts.state,
      createdAt: prior?.createdAt ?? ts,
      updatedAt: ts,
      ...(prior?.attachedSessions || opts.sessionId ? { attachedSessions: attached } : {}),
      ...(opts.label ? { label: opts.label } : prior?.label ? { label: prior.label } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : prior?.cwd ? { cwd: prior.cwd } : {}),
      ...(opts.originSessionId
        ? { originSessionId: opts.originSessionId }
        : prior?.originSessionId
          ? { originSessionId: prior.originSessionId }
          : {}),
      ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
      ...(opts.gitTokenWorkspace
        ? { gitTokenWorkspace: opts.gitTokenWorkspace }
        : prior?.gitTokenWorkspace
          ? { gitTokenWorkspace: prior.gitTokenWorkspace }
          : {}),
    }
    upsertSandboxLedger(entry, target)
  } catch {
    // Best-effort, always.
  }
}

/** Stamp a state transition ("paused"/"stopped"/"gone") for an existing row.
 *  Best-effort: never throws.
 *
 *  AIP-36 shared-box semantics: `attachedSessions` is a REFCOUNT, so a
 *  generic state stamp must not erase it under the survivors' feet. By
 *  default the stamp CLEARS the list (safe default: every stop is terminal
 *  and a stale attaché must not make `sandbox gc` skip the box forever);
 *  call with `keepAttachedSessions` only when the box physically kept
 *  running for other sessions (e.g. a reuse attach whose failed boot left
 *  the box PAUSED for the survivors — they re-attach through `reuse`). */
export function recordSandboxState(
  sandboxId: string,
  state: "paused" | "stopped" | "gone",
  path?: string,
  keepAttachedSessions?: boolean,
): void {
  try {
    const target = path ?? sandboxLedgerPath()
    const prior = readSandboxLedger(target).find(e => e.sandboxId === sandboxId)
    if (!prior) return // Nothing boot recorded — no row to transition.
    upsertSandboxLedger(
      {
        ...prior,
        state,
        ...(keepAttachedSessions ? {} : { attachedSessions: [] }),
        updatedAt: nowIso(),
      },
      target,
    )
  } catch {
    // Best-effort, always.
  }
}

/** Stamp the teardown of an idle-reaped sandbox session: the final state
 *  ("stopped" for a kill, "paused" when the lifecycle policy asked to pause)
 *  plus the reap provenance (`reapedAt` / `reapedIdleMs` / `reapedSessionId`).
 *  Best-effort: never throws. No-op without a boot row, like
 *  {@link recordSandboxState}. */
export function recordSandboxReap(
  sandboxId: string,
  state: "paused" | "stopped",
  info: { idleMs: number; sessionId?: string },
  path?: string,
): void {
  try {
    const target = path ?? sandboxLedgerPath()
    const prior = readSandboxLedger(target).find(e => e.sandboxId === sandboxId)
    if (!prior) return
    const ts = nowIso()
    upsertSandboxLedger(
      {
        ...prior,
        state,
        updatedAt: ts,
        // The box is no longer serving anyone.
        attachedSessions: [],
        reapedAt: ts,
        reapedIdleMs: info.idleMs,
        ...(info.sessionId ? { reapedSessionId: info.sessionId } : {}),
      },
      target,
    )
  } catch {
    // Best-effort, always.
  }
}

/** Stamp a PROVIDER liveness verdict onto an existing row — `sandboxAlive`
 *  + `sandboxCheckedAt`, and when the verdict is death ALSO flip the row to
 *  `"gone"` (the state alone was never evidence of death; the probe is).
 *  Best-effort: never throws. */
export function recordSandboxLiveness(
  sandboxId: string,
  alive: boolean,
  path?: string,
): void {
  try {
    const target = path ?? sandboxLedgerPath()
    const prior = readSandboxLedger(target).find(e => e.sandboxId === sandboxId)
    if (!prior) return
    upsertSandboxLedger(
      {
        ...prior,
        ...(alive ? {} : { state: "gone" as const }),
        sandboxAlive: alive,
        sandboxCheckedAt: nowIso(),
        updatedAt: nowIso(),
      },
      target,
    )
  } catch {
    // Best-effort, always.
  }
}

/** Backfill `originSessionId` once the HOST registry has minted the session
 *  id the box was spawned for (the boot hook runs before that id exists).
 *  Best-effort: never throws. */
export function recordSandboxOrigin(sandboxId: string, originSessionId: string, path?: string): void {
  try {
    const target = path ?? sandboxLedgerPath()
    const prior = readSandboxLedger(target).find(e => e.sandboxId === sandboxId)
    if (!prior) return
    upsertSandboxLedger(
      {
        ...prior,
        originSessionId,
        // The boot hook ran before the host minted this session id — count
        // the session into the shared-box refcount now, same write.
        attachedSessions: attachToSessions(prior.attachedSessions, originSessionId),
        updatedAt: nowIso(),
      },
      target,
    )
  } catch {
    // Best-effort, always.
  }
}

export type ReuseResolution =
  | { kind: "resolved"; sandboxId: string; entry: SandboxLedgerEntry }
  | { kind: "ambiguous"; candidates: SandboxLedgerEntry[] }
  | { kind: "unresolved" }

/**
 * `reuse: "<label-or-id>"` resolution against the ledger (PLAN-D1 §3).
 *
 * A reuse token that exactly matches a row's `label`, or is a PREFIX of
 * exactly one row's `sandboxId`, resolves to that row's sandboxId. Several
 * matches → `ambiguous` (the caller must disambiguate — the error it
 * renders lists the candidates). No match at all → `unresolved`, and the
 * spawn path passes the token through unchanged so the provider's own
 * `connect()` failure surfaces exactly as it did before this module
 * existed.
 */
export function resolveReuseFromLedger(
  reuse: string,
  entries: readonly SandboxLedgerEntry[],
): ReuseResolution {
  const matches = entries.filter(
    e => e.label === reuse || e.sandboxId.startsWith(reuse),
  )
  const sole = matches.length === 1 ? matches[0] : undefined
  if (sole) return { kind: "resolved", sandboxId: sole.sandboxId, entry: sole }
  if (matches.length > 1) return { kind: "ambiguous", candidates: matches }
  return { kind: "unresolved" }
}

/** Record one session DETACHING from a box (AIP-36 shared-box teardown:
 *  teardown = detach, the box survives as long as others remain). Drops
 *  `sessionId` from `attachedSessions`; no-op for a row this session isn't
 *  on. Returns the sessions STILL attached (excluding `sessionId`).
 *  Best-effort: never throws. */
export function recordSessionDetach(
  sandboxId: string,
  sessionId: string,
  path?: string,
): string[] {
  try {
    const target = path ?? sandboxLedgerPath()
    const prior = readSandboxLedger(target).find(e => e.sandboxId === sandboxId)
    if (!prior) return []
    const remaining = (prior.attachedSessions ?? []).filter(s => s !== sessionId)
    upsertSandboxLedger(
      { ...prior, attachedSessions: remaining, updatedAt: nowIso() },
      target,
    )
    return remaining
  } catch {
    return []
  }
}
