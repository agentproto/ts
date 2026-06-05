/**
 * Authorize — the policy/interface layer.
 *
 * Every spend carries an `intent`. The boundary is AGENCY, not destination:
 *   passive  = the cost of the agent existing/thinking (inference, memory). Even
 *              though money leaves to a provider, the agent chose nothing → gated
 *              only by available balance + the `operating` cap.
 *   active   = an economic action the agent CHOSE (pay a service, x402, transfer,
 *              withdraw) → gated by the `discretionary` envelope. This is the
 *              safety-critical budget: it bounds the agent's discretion to MOVE
 *              value out, separately from its right to operate.
 *
 * Delegation resolves by LINEAGE-MIN: a child's effective envelope is the
 * element-wise minimum down the delegation chain — a delegate can never widen
 * what it was granted.
 */

import type { AssetRef } from "./asset.js"
import type { Intent } from "./fold.js"

export interface OperatingAllowance {
  /** Cap on passive spend (omit = unbounded "operate while balance lasts"). */
  cap?: number
}

export interface DiscretionaryAllowance {
  /** Cap on a single active spend amount. */
  cap?: number
  /** Throughput cap over a rolling window. */
  ratePerWindow?: { amount: number; windowSec: number }
  /** Allow-list of counterparties value may be paid to (omit = any). */
  counterparties?: readonly string[]
  /** Allow-list of assets that may be actively spent (omit = any). */
  assets?: readonly AssetRef[]
}

export interface AllowanceEnvelope {
  operating?: OperatingAllowance
  discretionary?: DiscretionaryAllowance
}

export interface AuthorizeRequest {
  asset: AssetRef
  category: string
  amount: number
  intent: Intent
  /** Spendable balance for the asset (Σ remaining − reserved). */
  spendableBalance: number
  /** Does the asset's rule set permit value to settle OUT for this action? */
  settleOutAllowed?: boolean
  counterparty?: string
  /** Active spend already made in the current window (for ratePerWindow). */
  windowSpent?: number
  /** Effective envelope (already lineage-min-resolved). */
  envelope?: AllowanceEnvelope
}

export type AuthzReason =
  | "insufficient-balance"
  | "operating-cap-exceeded"
  | "discretionary-cap-exceeded"
  | "rate-limit-exceeded"
  | "counterparty-not-allowed"
  | "asset-not-allowed"
  | "settle-out-forbidden"

export type AuthorizeDecision =
  | { ok: true }
  | { ok: false; reason: AuthzReason }

const DENY = (reason: AuthzReason): AuthorizeDecision => ({ ok: false, reason })

/** Decide whether a spend is authorized. Pure — no I/O. */
export function authorize(req: AuthorizeRequest): AuthorizeDecision {
  if (req.amount > req.spendableBalance) return DENY("insufficient-balance")

  if (req.intent === "passive") {
    const cap = req.envelope?.operating?.cap
    if (cap !== undefined && req.amount > cap) {
      return DENY("operating-cap-exceeded")
    }
    return { ok: true }
  }

  // active — the discretionary, safety-critical path.
  if (req.settleOutAllowed === false) return DENY("settle-out-forbidden")
  const d = req.envelope?.discretionary
  if (d) {
    if (d.cap !== undefined && req.amount > d.cap) {
      return DENY("discretionary-cap-exceeded")
    }
    if (d.ratePerWindow) {
      const spent = req.windowSpent ?? 0
      if (spent + req.amount > d.ratePerWindow.amount) {
        return DENY("rate-limit-exceeded")
      }
    }
    if (
      d.counterparties &&
      req.counterparty !== undefined &&
      !d.counterparties.includes(req.counterparty)
    ) {
      return DENY("counterparty-not-allowed")
    }
    if (d.assets && !d.assets.includes(req.asset)) {
      return DENY("asset-not-allowed")
    }
  }
  return { ok: true }
}

const minDefined = (a?: number, b?: number): number | undefined => {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.min(a, b)
}

/** Intersect two allow-lists (undefined = "any" is the wider element). */
function intersectList<T>(
  a: readonly T[] | undefined,
  b: readonly T[] | undefined,
): readonly T[] | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  const set = new Set(b)
  return a.filter(x => set.has(x))
}

/**
 * Lineage-min: fold a delegation chain (root → leaf) into one effective
 * envelope. Caps take the min, allow-lists intersect, rate windows take the
 * tighter amount — a delegate can only ever NARROW its parent's grant.
 */
export function minEnvelope(
  chain: readonly AllowanceEnvelope[],
): AllowanceEnvelope {
  return chain.reduce<AllowanceEnvelope>((acc, e) => {
    const ratePerWindow =
      acc.discretionary?.ratePerWindow ?? e.discretionary?.ratePerWindow
        ? {
            amount: minDefined(
              acc.discretionary?.ratePerWindow?.amount,
              e.discretionary?.ratePerWindow?.amount,
            )!,
            windowSec:
              acc.discretionary?.ratePerWindow?.windowSec ??
              e.discretionary?.ratePerWindow?.windowSec ??
              0,
          }
        : undefined
    return {
      operating: {
        cap: minDefined(acc.operating?.cap, e.operating?.cap),
      },
      discretionary: {
        cap: minDefined(acc.discretionary?.cap, e.discretionary?.cap),
        ratePerWindow,
        counterparties: intersectList(
          acc.discretionary?.counterparties,
          e.discretionary?.counterparties,
        ),
        assets: intersectList(acc.discretionary?.assets, e.discretionary?.assets),
      },
    }
  }, {})
}
