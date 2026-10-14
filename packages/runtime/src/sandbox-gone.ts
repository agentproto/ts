/**
 * "Box gone" detection for a DEAD box session — the one helper the
 * restart-scheduler's `sandbox-gone` policy trigger consults (and the seam
 * `session_restart`'s fresh-box move already relies on implicitly).
 *
 * For a session that ran inside a sandbox box (`SessionDescriptor.sandboxId`),
 * an in-place revival (`maybeResumeAgent`) is structurally doomed once the BOX
 * itself is gone — lifetime cap reached, provider reclaimed it, or the box
 * became unreachable past recovery. What CAN still work is the fresh-box move
 * `restartAgentSession` already performs (`spawnOnFreshBox`: re-clone the
 * workspace remote, re-check the work branch out). This module answers only
 * the prerequisite question — IS the box gone? — from evidence the daemon
 * already has, with no new polling loop:
 *
 *   1. `endedReason: "sandbox_gone"` — stamped by the boot reattach pass
 *      (`sandbox-reattach.ts`) after the PROVIDER itself said the box (or its
 *      session) no longer exists. Definitive.
 *   2. A recorded death message the proxy / provider produced when the box
 *      died — the e2b SDK's "Sandbox is probably not running anymore"
 *      (lifetime cap), the proxy watchdog's health-check give-up, its
 *      consecutive-poll give-up, or a connect attempt's box-gone error. Read
 *      off the descriptor fields the turn-error / crash paths already stamp.
 *   3. The sandbox ledger's `gone` state for this box (`recordSandboxState`,
 *      written wherever an `isSandboxBoxGoneError` was caught).
 *   4. A ONE-SHOT provider probe (`SandboxProvider.probe` — a cheap control-
 *      plane `GET /sandboxes/:id`) when the caller wires a resolver. A throw
 *      or an absent `probe` is "unknown", never death.
 *
 * Anything unconfirmed reports false — a false negative falls back to the
 * classic in-place restart gates exactly as before; a false positive would
 * burn a fresh box for nothing, so the bias is deliberately toward "not gone".
 */

import { isSandboxBoxGoneError } from "@agentproto/sandbox"
import type { SessionDescriptor } from "./sessions.js"
import { readSandboxLedger } from "./sandbox-ledger.js"
import { parseSandboxProviderSlug } from "./session-restart-core.js"
import type { SandboxProviderResolver } from "./sandbox-adapters.js"

/**
 * Death messages that name the BOX (not the session, not the adapter) as the
 * thing that died. Narrow on purpose — an ordinary turn error, an adapter
 * crash, or a provider usage cap never matches, so those keep today's
 * in-place restart behaviour untouched.
 */
const BOX_GONE_MESSAGE_RE = [
  // e2b SDK / provider control plane, typically at the box's lifetime cap.
  /sandbox is probably not running anymore/i,
  // The proxy watchdog's give-up after repeated failed box-daemon health
  // probes — anchored to the "N times in a row" give-up wording so an
  // ordinary single health-check blip never counts as box-gone ("… failed
  // its health check N times in a row (crash, OOM, or the box is gone)" /
  // "… did not answer its health check N times in a row …").
  /sandbox proxy:.*health check.*\d+ times in a row/i,
  // The proxy's long-poll fallback giving up against an unreachable box daemon.
  /sandbox proxy:.*consecutive poll failures against the box daemon/i,
  // A host-connect/reattach attempt that hit `SandboxBoxGoneError` (or the
  // provider's own "sandbox not found" wording) and got recorded as the death.
  /SandboxBoxGoneError/i,
  /sandbox ["']?[\w:-]+["']? (?:is )?not found/i,
]

/** True when `text` carries one of the recorded box-gone death messages. */
export function isBoxGoneMessage(text: string | undefined): boolean {
  if (!text) return false
  return BOX_GONE_MESSAGE_RE.some(re => re.test(text))
}

/** True when this descriptor is a session that ran (or was meant to run)
 *  inside a sandbox box — the only shape for which "the box is gone" is a
 *  meaningful question. */
export function isBoxSession(desc: Pick<SessionDescriptor, "sandboxId">): boolean {
  return desc.sandboxId !== undefined && desc.sandboxId !== ""
}

/**
 * Synchronous box-gone classification from evidence ALREADY stamped on the
 * dead descriptor: the reattach pass's definitive `endedReason:"sandbox_gone"`
 * (also true when `err.name === "SandboxBoxGoneError"` got persisted into the
 * reason by an older/other path), or a recorded death message matching
 * {@link BOX_GONE_MESSAGE_RE} in `lastError` / `lastTurnErrorMessage`.
 */
export function hasSandboxGoneEvidence(
  desc: Pick<SessionDescriptor, "endedReason" | "lastError" | "lastTurnErrorMessage">,
): boolean {
  if (desc.endedReason === "sandbox_gone") return true
  return isBoxGoneMessage(desc.lastError) || isBoxGoneMessage(desc.lastTurnErrorMessage)
}

/** Deps {@link isSandboxBoxGone} consults beyond the descriptor itself. */
export interface SandboxGoneProbeDeps {
  /** Resolves the session's sandbox provider for the one-shot liveness
   *  probe. Omitted ⇒ step 4 is skipped. */
  resolveSandboxProvider?: SandboxProviderResolver
  /** Ledger read override — tests pin a tmpdir. Defaults to
   *  `readSandboxLedger()`'s own path resolution. */
  readLedger?: () => ReturnType<typeof readSandboxLedger>
}

/**
 * Full async classification for a dead box session: the synchronous
 * descriptor evidence first, then the sandbox ledger's `gone` state for this
 * box, then (when a resolver is wired) ONE provider probe. Never throws and
 * never polls — an unavailable check is simply "not confirmed gone".
 */
export async function isSandboxBoxGone(
  desc: SessionDescriptor,
  deps: SandboxGoneProbeDeps = {},
): Promise<boolean> {
  if (!isBoxSession(desc)) return false
  if (hasSandboxGoneEvidence(desc)) return true
  const sandboxId = desc.sandboxId!
  try {
    const ledger = deps.readLedger ? deps.readLedger() : readSandboxLedger()
    if (ledger.some(entry => entry.sandboxId === sandboxId && entry.state === "gone")) return true
  } catch {
    // ledger unreadable — not confirmation
  }
  const providerSlug = parseSandboxProviderSlug(desc.command)
  if (!providerSlug || !deps.resolveSandboxProvider) return false
  try {
    const handle = await deps.resolveSandboxProvider(providerSlug)
    if (!handle?.provider.probe) return false
    const result = await handle.provider.probe(sandboxId)
    return result.alive === false
  } catch {
    return false
  }
}

// Re-exported so callers that only need the classification never import
// `@agentproto/sandbox` themselves (and so a future re-wording of the error
// class stays an internal detail of this module).
export { isSandboxBoxGoneError }
