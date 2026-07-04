/**
 * Access control types — workspace-override rules + app scope.
 *
 * v1 ships the evaluator + types; the DB-backed `model_access_rules`
 * table follows in v2 (the MCP gen layer reads rows and threads them
 * through `evaluateAccess` per workspace).
 */

import type { ModelKind } from "../schema/index.js"

export type AccessEffect = "allow" | "block"

export type AccessTarget =
  | { kind: "model"; id: string }
  | { kind: "tag"; value: string }
  | { kind: "provider"; value: string }
  /**
   * `kind: "priceTier"` is the persisted DB discriminator string for
   * catalog-price-tier targets (`low | mid | high | premium`). The
   * conceptual name is `catalogPriceTier`; the literal stays `priceTier`
   * to avoid breaking existing rows in `*_model_access_rules` tables.
   */
  | { kind: "priceTier"; value: "low" | "mid" | "high" | "premium" }
  | { kind: "kind"; value: ModelKind }

export interface AccessRule {
  effect: AccessEffect
  target: AccessTarget
  /** Audit reason; surfaced in decision.reason. */
  reason?: string
}

/**
 * Per-product opt-in: the app declares which kinds it surfaces. Lets
 * one app hide LLMs, another hide video, etc. Empty `kinds` means the app
 * does not constrain by kind (admin / catalog-browser scope).
 */
export interface AppScope {
  kinds: ModelKind[]
}
