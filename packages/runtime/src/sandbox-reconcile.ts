/**
 * Sandbox ledger reconcile — closes the gap between what
 * `~/.agentproto/sandboxes.json` believes is still booted/paused/connected
 * and what the PROVIDER actually still has running. A failed teardown, a
 * daemon that crashed mid-close, or a provider-side idle-reap the daemon
 * never heard about all leave a ledger row claiming a box is alive long
 * after the provider reaped it — real-world evidence: one daemon's ledger
 * carried ~50 rows in "paused" while the provider had far fewer boxes left.
 *
 * This is read-only against the PROVIDER (`SandboxProvider.probe`, the same
 * primitive `GET /sandboxes/:id/alive` and `agentproto sandbox list` already
 * use per-row) and never tears a box down — it only ever flips a ledger
 * row's `state` to `"gone"` via `recordSandboxLiveness` when the provider
 * confirms the box no longer exists. A box a caller still wants stays
 * completely untouched; this module has no `stop()`/`pause()`/`connect()`
 * call anywhere in it.
 */
import {
  readSandboxLedger,
  recordSandboxLiveness,
  type SandboxLedgerEntry,
  type SandboxLedgerState,
} from "./sandbox-ledger.js"

/** The slice of `SandboxProviderHandle` reconcile needs — just the liveness
 *  probe, so tests (and the `local` provider, which has none) can hand back
 *  a handle without a `probe` at all. */
export interface SandboxReconcileProviderHandle {
  provider: {
    probe?(sandboxId: string): Promise<{ alive: boolean; state?: string }>
  }
}

export interface SandboxReconcileDeps {
  /** Resolve a ledger row's provider slug to a handle. Mirrors
   *  `SandboxGcReapDeps.resolveProvider` (`sandbox-gc.ts`) — same DI shape,
   *  narrower need (probe only, never connect/boot). */
  resolveProvider: (slug: string) => Promise<SandboxReconcileProviderHandle | null>
  /** Defaults to `readSandboxLedger` — injectable so callers that already
   *  hold a mocked/scoped ledger reader (tests, a scoped CLI mock) can reuse
   *  it instead of this module reaching for the real `~/.agentproto/
   *  sandboxes.json` on disk. */
  readLedger?: (path?: string) => SandboxLedgerEntry[]
  /** Defaults to `recordSandboxLiveness` — same injectability reasoning. */
  recordLiveness?: (sandboxId: string, alive: boolean, path?: string) => void
  ledgerPath?: string
}

/** Verdict for one reconciled row. `"skipped"` means the provider has no
 *  `probe()` (e.g. Box today) — never treated as evidence of death. */
export type SandboxReconcileVerdict = "alive" | "gone" | "unknown" | "skipped"

export interface SandboxReconcileRow {
  sandboxId: string
  provider: string
  verdict: SandboxReconcileVerdict
  /** Present when `verdict` is "unknown" — the resolve/probe failure message. */
  error?: string
}

export interface SandboxReconcileResult {
  checked: number
  alive: number
  gone: number
  unknown: number
  skipped: number
  rows: SandboxReconcileRow[]
}

/** Ledger states the reconcile bothers to re-check — the ones where the
 *  ledger currently claims a box is still around. Rows already "stopped" or
 *  "gone" have nothing left to reconcile. */
const RECONCILABLE_STATES: ReadonlySet<SandboxLedgerState> = new Set([
  "booted",
  "connected",
  "paused",
])

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Probe every ledger row still claiming to be alive against its provider,
 * and stamp the verdict back into the ledger (`recordSandboxLiveness` flips
 * a dead row to `"gone"`; a live or unprobeable row is left as-is). One
 * broken row's provider resolution or probe call never aborts the pass for
 * the rest — each row's outcome is independent and best-effort.
 */
export async function reconcileSandboxLedger(
  deps: SandboxReconcileDeps,
): Promise<SandboxReconcileResult> {
  const readLedger = deps.readLedger ?? readSandboxLedger
  const recordLiveness = deps.recordLiveness ?? recordSandboxLiveness
  const entries = readLedger(deps.ledgerPath).filter(e => RECONCILABLE_STATES.has(e.state))

  const rows: SandboxReconcileRow[] = []
  for (const entry of entries) {
    let handle: SandboxReconcileProviderHandle | null
    try {
      handle = await deps.resolveProvider(entry.provider)
    } catch (err) {
      rows.push({
        sandboxId: entry.sandboxId,
        provider: entry.provider,
        verdict: "unknown",
        error: `provider "${entry.provider}" could not be resolved — ${errorMessage(err)}`,
      })
      continue
    }
    if (!handle?.provider?.probe) {
      rows.push({ sandboxId: entry.sandboxId, provider: entry.provider, verdict: "skipped" })
      continue
    }
    try {
      const probe = await handle.provider.probe(entry.sandboxId)
      recordLiveness(entry.sandboxId, probe.alive, deps.ledgerPath)
      rows.push({
        sandboxId: entry.sandboxId,
        provider: entry.provider,
        verdict: probe.alive ? "alive" : "gone",
      })
    } catch (err) {
      rows.push({
        sandboxId: entry.sandboxId,
        provider: entry.provider,
        verdict: "unknown",
        error: `liveness probe failed — ${errorMessage(err)}`,
      })
    }
  }

  return {
    checked: rows.length,
    alive: rows.filter(r => r.verdict === "alive").length,
    gone: rows.filter(r => r.verdict === "gone").length,
    unknown: rows.filter(r => r.verdict === "unknown").length,
    skipped: rows.filter(r => r.verdict === "skipped").length,
    rows,
  }
}
