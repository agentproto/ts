/**
 * `agentproto sandbox gc` — the orphan-box reaper.
 *
 * A sandboxed spawn that FAILS after the box was created (boot failure
 * after `provider.boot` returned, a reconnect whose daemon MCP connect
 * failed, the box's own `agent_start` rejecting, …) leaves a live box on
 * its provider with no owning session. So does a session that then died
 * (error/killed/exited) while its box idled to a PAUSED state on e2b —
 * and paused boxes still bill.
 *
 * The spawn path now reaps failed boots itself (see
 * `session-spawn.ts`), but boxes orphaned before that fix exist in the
 * ledger. The gc selects ledger entries whose ORIGIN SESSION ended in a
 * terminal-failure state (`error` / `killed` / `exited`), and — with
 * `apply` — tears the box down on its provider (kill by default; `pause`
 * keeps it attachable for boxes you still want) and stamps the ledger.
 * Dry run by default.
 */
import type { SandboxProviderHandle } from "./sandbox-providers/types.js"
import type { SandboxLedgerEntry, SandboxLedgerState } from "./sandbox-ledger.js"
import { recordSandboxState } from "./sandbox-ledger.js"

/** Host session statuses after which a session can never use its box again. */
export const DEAD_SESSION_STATUSES: ReadonlySet<string> = new Set(["error", "killed", "exited"])

/** One ledger row selected for gc, with the observed origin-session status. */
export interface SandboxGcCandidate {
  entry: SandboxLedgerEntry
  sessionStatus: string
}

/**
 * Select ledger entries whose origin session is error/killed/exited.
 * Rows already marked "stopped" are skipped (nothing left to tear down);
 * rows with no `originSessionId` are skipped too — their owning session
 * is unknown, so "orphan" cannot be established from this surface.
 */
export function collectGcCandidates(
  entries: readonly SandboxLedgerEntry[],
  sessionStatuses: ReadonlyMap<string, string>,
): SandboxGcCandidate[] {
  return entries
    .filter(e => e.originSessionId !== undefined && e.state !== "stopped")
    .map(entry => ({
      entry,
      sessionStatus: sessionStatuses.get(entry.originSessionId as string),
    }))
    .filter(
      (c): c is SandboxGcCandidate & { sessionStatus: string } =>
        c.sessionStatus !== undefined && DEAD_SESSION_STATUSES.has(c.sessionStatus),
    )
}

/** Provider resolution + ledger targeting for the reaper — injectable so
 *  tests can hand a fake provider and a tmp ledger path. */
export interface SandboxGcReapDeps {
  resolveProvider: (slug: string) => Promise<SandboxGcProviderHandle | null>
  ledgerPath?: string
}

/** The slice of `SandboxProviderHandle` the reaper needs. */
export interface SandboxGcProviderHandle {
  provider: {
    connect(
      sandboxId: string,
      spec: { provider: string; config: Record<string, unknown> },
      opts: { env: Record<string, string> },
    ): Promise<{
      sandboxId: string
      stop(): Promise<void>
      pause?(): Promise<void>
    }>
  }
}

export type SandboxGcReapResult =
  | { ok: true; action: "paused" | "stopped" }
  | { ok: false; error: string }

/**
 * Tear one ledger entry's box down on its provider and stamp the ledger.
 * `pause` keeps the box (pausing when the provider supports it, falling
 * back to a kill otherwise); the default kills. A connect failure that
 * reads as "box doesn't exist anymore" still stamps the row "stopped" so
 * the candidate stops re-appearing; other failures leave the row alone
 * (transient network must not mark a live box as reaped).
 */
export async function reapGcEntry(
  entry: SandboxLedgerEntry,
  opts: { pause?: boolean } & SandboxGcReapDeps,
): Promise<SandboxGcReapResult> {
  let handle: SandboxGcProviderHandle | null
  try {
    handle = await opts.resolveProvider(entry.provider)
  } catch (err) {
    return {
      ok: false,
      error: `provider "${entry.provider}" could not be resolved — ${
        err instanceof Error ? err.message : String(err)
      }`,
    }
  }
  if (!handle) return { ok: false, error: `provider "${entry.provider}" not found.` }
  if (!handle.provider.connect) {
    return {
      ok: false,
      error: `provider "${entry.provider}" has no connect() — cannot reach the existing box.`,
    }
  }
  let booted: Awaited<ReturnType<NonNullable<typeof handle.provider.connect>>>
  try {
    booted = await handle.provider.connect(
      entry.sandboxId,
      { provider: entry.provider, config: {} },
      { env: {} },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/\b404\b|doesn't exist|does not exist|not found|no such/i.test(message)) {
      recordSandboxState(entry.sandboxId, "stopped", opts.ledgerPath)
      return { ok: true, action: "stopped" }
    }
    return { ok: false, error: `connect to "${entry.sandboxId}" failed — ${message}` }
  }
  const action: "paused" | "stopped" =
    opts.pause === true && booted.pause ? "paused" : "stopped"
  try {
    if (action === "paused") await booted.pause!()
    else await booted.stop()
  } catch (err) {
    return {
      ok: false,
      error: `tearing down "${entry.sandboxId}" failed — ${
        err instanceof Error ? err.message : String(err)
      }`,
    }
  }
  recordSandboxState(entry.sandboxId, action, opts.ledgerPath)
  return { ok: true, action }
}

/** States that still name a box the gc might act on. */
export const GC_REAPABLE_STATES: readonly SandboxLedgerState[] = ["booted", "connected", "paused"]