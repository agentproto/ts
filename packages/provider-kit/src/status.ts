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
  /** From the handle — does a spawn HARD-FAIL without a billing credential?
   *  Independent of `requiresSetup`: an adapter can need no `setup[]` pass and
   *  still refuse every spawn (claude-code's `authEnforce: "always"`).
   *  Undefined for families with no auth notion (tunnel/sandbox/eval). */
  authRequired?: boolean
  /** Whether a credential actually RESOLVES (mirrors `resolveAuthSpec`,
   *  including the explicit-gate on the providers store — see
   *  `isAgentCliAuthConfigured`). Only meaningful when `authRequired` is
   *  true; undefined otherwise. */
  authConfigured?: boolean
}

/**
 * Classify an adapter into supported/available/ready.
 *
 *   !resolved                                                → "supported"
 *   resolved && authRequired && !authConfigured              → "available"
 *   resolved && !requiresSetup                                → "ready"
 *   resolved && requiresSetup && (ledger || creds)            → "ready"
 *   resolved && requiresSetup && !ledger && !creds            → "available"
 *
 * `authRequired`/`authConfigured` are checked BEFORE the `!requiresSetup`
 * short-circuit — auth is its own axis, not a flavour of `requiresSetup`.
 * An adapter can declare no `setup[]` at all and still hard-fail every spawn
 * for want of a billing credential (claude-code); folding that into
 * `requiresSetup`/`credsExist` would let a completed setup ledger mask
 * missing auth the moment anyone adds a `setup[]` to such an adapter.
 */
export function computeStatus(opts: ComputeStatusOpts): AdapterStatus {
  const { resolved, requiresSetup, ledgerExists, credsExist, authRequired, authConfigured } = opts
  if (!resolved) return "supported"
  if (authRequired === true && authConfigured !== true) return "available"
  if (!requiresSetup) return "ready"
  if (ledgerExists || credsExist === true) return "ready"
  return "available"
}
