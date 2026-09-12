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

export interface SandboxLedgerEntry {
  sandboxId: string
  provider: string
  state: SandboxLedgerState
  createdAt: string
  updatedAt: string
  label?: string
  cwd?: string
  /** The HOST session id that first booted / last reconnected to the box. */
  originSessionId?: string
  /** ISO instant the box is expected to idle-expire — stamped only when the
   *  boot knew a window (`lifecycle.pause_after_idle`). */
  expiresAt?: string
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
  path?: string
}): void {
  try {
    const target = opts.path ?? sandboxLedgerPath()
    const existing = readSandboxLedger(target)
    const prior = existing.find(e => e.sandboxId === opts.sandboxId)
    const ts = nowIso()
    const entry: SandboxLedgerEntry = {
      sandboxId: opts.sandboxId,
      provider: opts.provider,
      state: opts.state,
      createdAt: prior?.createdAt ?? ts,
      updatedAt: ts,
      ...(opts.label ? { label: opts.label } : prior?.label ? { label: prior.label } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : prior?.cwd ? { cwd: prior.cwd } : {}),
      ...(opts.originSessionId
        ? { originSessionId: opts.originSessionId }
        : prior?.originSessionId
          ? { originSessionId: prior.originSessionId }
          : {}),
      ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
    }
    upsertSandboxLedger(entry, target)
  } catch {
    // Best-effort, always.
  }
}

/** Stamp a state transition ("paused"/"stopped"/"gone") for an existing row.
 *  Best-effort: never throws. */
export function recordSandboxState(
  sandboxId: string,
  state: "paused" | "stopped" | "gone",
  path?: string,
): void {
  try {
    const target = path ?? sandboxLedgerPath()
    const prior = readSandboxLedger(target).find(e => e.sandboxId === sandboxId)
    if (!prior) return // Nothing boot recorded — no row to transition.
    upsertSandboxLedger(
      { ...prior, state, updatedAt: nowIso() },
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
      { ...prior, originSessionId, updatedAt: nowIso() },
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
