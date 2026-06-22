/**
 * Status engine — a pure, synchronous function fed pre-resolved booleans.
 *
 * Per OQ-2 (resolved): `computeStatus` does NOT do any I/O. The caller
 * (the lister) resolves `resolved` / `ledgerExists` / `credsExist` first,
 * then asks the engine to classify. `check()` is never part of this path.
 */

import type { AdapterStatus } from "./types.js"

export interface ComputeStatusOpts {
  /** Did `resolveAdapter()` succeed (handle importable)? */
  resolved: boolean
  /** From the handle — does it need a creds/setup pass? */
  requiresSetup: boolean
  /** From `SetupLedger.exists()`. */
  ledgerExists: boolean
  /** From `CredsStore.exists()`. Optional — undefined when no creds store. */
  credsExist?: boolean
}

/**
 * Classify an adapter into supported/available/ready.
 *
 *   !resolved                                          → "supported"
 *   resolved && !requiresSetup                          → "ready"
 *   resolved && requiresSetup && (ledger || creds)      → "ready"
 *   resolved && requiresSetup && !ledger && !creds      → "available"
 */
export function computeStatus(opts: ComputeStatusOpts): AdapterStatus {
  const { resolved, requiresSetup, ledgerExists, credsExist } = opts
  if (!resolved) return "supported"
  if (!requiresSetup) return "ready"
  if (ledgerExists || credsExist === true) return "ready"
  return "available"
}
