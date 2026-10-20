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
import { readSandboxLedger, recordSandboxState } from "./sandbox-ledger.js"

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
    // AIP-36 shared-box amendment — the origin session dying does not make
    // the box an orphan when OTHER sessions are still attached. Skip unless
    // every remaining attaché is itself dead (its status is terminal);
    // an unknown survivor status conservatively keeps the box alive.
    .filter(c => {
      const others = (c.entry.attachedSessions ?? []).filter(
        s => s !== c.entry.originSessionId,
      )
      if (others.length === 0) return true
      return others.every(s => {
        const st = sessionStatuses.get(s)
        return st !== undefined && DEAD_SESSION_STATUSES.has(st)
      })
    })
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
    connect?(
      sandboxId: string,
      spec: { provider: string; config: Record<string, unknown> },
      opts: { env: Record<string, string> },
    ): Promise<{
      sandboxId: string
      stop(): Promise<void>
      pause?(): Promise<void>
    }>
    /** Control-plane destroy WITHOUT connecting — see `SandboxProvider.
     *  remove`. Preferred over `connect()` + `stop()`: connecting to a
     *  suspended computer RESUMES it first (RAM requirement), exactly the
     *  capacity-need that made `sandbox rm`/gc fail on an exhausted host.
     *  Optional: providers without it fall back to the connect path. */
    remove?(sandboxId: string): Promise<void>
  }
}

/** Error-message shapes meaning "the box is already gone" — an idempotent
 *  successful gc, never a failure. */
const GONE_RE =
  /\b404\b|doesn't exist|does not exist|not found|no such|box gone|sandbox not found/i

/** Structural check — true when `err` means "the box is gone" (the typed
 *  sentinel or any Error carrying its name). */
function isGoneError(err: unknown): boolean {
  return err instanceof Error && err.name === "SandboxBoxGoneError"
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
  // CAPACITY-FREE TEARDOWN: when the provider can destroy the box straight
  // on its control plane, never `connect()` first — connecting to a
  // suspended computer RESUMES it (RAM), requiring the capacity gc is meant
  // to free. `pause` keeps the connect path: pausing needs the handle's
  // lifecycle call. An id-already-gone outcome is a NO-OP success.
  if (opts.pause !== true && handle.provider.remove) {
    try {
      await handle.provider.remove(entry.sandboxId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (GONE_RE.test(message) || isGoneError(err)) {
        recordSandboxState(entry.sandboxId, "stopped", opts.ledgerPath)
        return { ok: true, action: "stopped" }
      }
      return { ok: false, error: `removing "${entry.sandboxId}" failed — ${message}` }
    }
    recordSandboxState(entry.sandboxId, "stopped", opts.ledgerPath)
    return { ok: true, action: "stopped" }
  }
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
/** Sources a session-status READ for the periodic gc. Injected so the
 *  daemon pass reads its OWN registry and the CLI keeps its HTTP one. */
export interface SandboxGcReadDeps {
  fetchSessionStatuses: () => Promise<Map<string, string>> | Map<string, string>
  resolveProvider: (slug: string) => Promise<SandboxGcProviderHandle | null>
  ledgerPath?: string
}

/** Tally of one automatic gc pass. */
export interface SandboxGcPassSummary {
  ran: boolean
  candidates: number
  stopped: number
  paused: number
  failures: number
}

/**
 * One automatic `sandbox gc` pass: read the session statuses, select the
 * ledger rows whose origin session is DEAD (error/killed/exited —
 * {@link collectGcCandidates}) and reap them with {@link reapGcEntry}.
 * Unlike the CLI's dry-run-first command, the daemon pass applies by
 * default (the operator chose to run a daemon; orphan boxes bill while
 * nobody looks at them), but a failure is always logged, never thrown.
 */
export async function runSandboxGcPass(
  deps: SandboxGcReadDeps,
  log: (line: string) => void = () => undefined,
): Promise<SandboxGcPassSummary> {
  const statuses = await deps.fetchSessionStatuses()
  const candidates = collectGcCandidates(readSandboxLedger(deps.ledgerPath), statuses)
  const summary: SandboxGcPassSummary = {
    ran: true,
    candidates: candidates.length,
    stopped: 0,
    paused: 0,
    failures: 0,
  }
  for (const candidate of candidates) {
    const res = await reapGcEntry(candidate.entry, {
      resolveProvider: deps.resolveProvider,
      ...(deps.ledgerPath !== undefined ? { ledgerPath: deps.ledgerPath } : {}),
    })
    if (res.ok) {
      if (res.action === "paused") summary.paused++
      else summary.stopped++
      log(
        `sandbox gc: ${candidate.entry.sandboxId} ${res.action} (session ${candidate.entry.originSessionId} ${candidate.sessionStatus})`,
      )
    } else {
      summary.failures++
      log(`sandbox gc: failed for ${candidate.entry.sandboxId} — ${res.error}`)
    }
  }
  return summary
}

/**
 * The daemon's PERIODIC automatic gc for dead-session boxes. Every
 * `intervalMs` (default {@link DEFAULT_SANDBOX_GC_INTERVAL_MS}) the pass
 * reaps ledger boxes whose origin session is gone — a paused computer
 * holding a RAM snapshot, a surviving-but-billing e2b box whose session
 * crashed and whose owner never ran `sandbox gc --apply`.
 * `.unref()` — the timer never keeps the process alive. Returns a handle
 * whose `stop()` kills the timer (the gateway's `stop()` calls it).
 */
export const DEFAULT_SANDBOX_GC_INTERVAL_MS = 60 * 60_000
export interface SandboxGcTimer {
  stop(): void
}

export function startSandboxGcTimer(
  deps: SandboxGcReadDeps & {
    intervalMs?: number
    log?: (line: string) => void
  },
): SandboxGcTimer {
  const intervalMs = deps.intervalMs ?? DEFAULT_SANDBOX_GC_INTERVAL_MS
  const log = deps.log ?? (line => console.log(line))
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    void (async () => {
      try {
        const summary = await runSandboxGcPass(deps, log)
        if (summary.candidates > 0) {
          log(
            `sandbox gc: ${summary.candidates} dead-session box(es) — ` +
              `${summary.stopped} stopped, ${summary.paused} paused, ${summary.failures} failed`,
          )
        }
      } catch (err) {
        log(`sandbox gc: pass failed — ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        running = false
      }
    })()
  }, intervalMs)
  timer.unref?.()
  return {
    stop: () => clearInterval(timer),
  }
}
