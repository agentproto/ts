/**
 * Pricing registry — single source of truth for the formula that turns
 * a provider's USD cost into centicredits charged to the user.
 *
 *   centicredits = max(floor_cc, ceil(baseCost × markup / CC_USD_RATE))
 *
 * Unit: **centicredits (cc)** throughout. 1 displayed credit = 100 cc.
 * Internal ledger column (`credit_transactions.credits`) stores cc, so
 * dispatcher output flows straight into the ledger with no per-call
 * `× 100` conversion. UI surfaces format cc → displayed credits at the
 * render boundary via `displayCredits(cc) → cr`.
 *
 * Why a registry (not constants):
 *   - The DEFAULTS work across apps. Most consumers (image gen, STT,
 *     etc.) need exactly the same markup ratios regardless of which
 *     app called them.
 *   - But apps want overrides — one app might want a lower video markup
 *     during a promo, another a higher one because their
 *     users skew heavier. `registerApp(appId, { video: 1.8 })` slots
 *     in without changing the catalog or the cost dispatcher.
 *   - Per-model `overrideCreditCost` is the third lever — a specific
 *     model can opt out of the formula entirely for strategic reasons
 *     (subsidized adoption, partner pricing).
 *
 * Lever priority (highest to lowest):
 *   1. `model.overrideCreditCost` — explicit cc-per-call, catalog entry
 *   2. app-scoped markup       — `registerApp(appId, partial)`
 *   3. core default markup     — `DEFAULT_PRICING_MARKUP`
 *
 * Currency: all provider rates are USD. 1 displayed credit = €0.01
 * retail ≈ $0.0108. Multi-currency selling prices live in per-app
 * plans-data — the markup formula itself stays USD-anchored.
 */

/**
 * Conversion: USD ↔ displayed credit. 1 displayed credit = €0.01
 * retail at pack rate. Prefer `CC_USD_RATE` for credit math — it
 * matches the cc unit the dispatcher emits.
 */
export const CREDIT_USD_RATE = 0.0108
/**
 * USD per centicredit. 1 cc = 1/100 of a displayed credit, so
 * `CC_USD_RATE = CREDIT_USD_RATE / 100`. Pre-computed once so the hot
 * `× markup / CC_USD_RATE` divide doesn't repeat the constant math.
 */
export const CC_USD_RATE = CREDIT_USD_RATE / 100

export type PricingCategory = "image" | "video" | "audio" | "text" | "search"

export interface PricingMarkup {
  /** Per-category markup applied to `baseCost` before USD→cc conversion. */
  markup: Partial<Record<PricingCategory, number>>
  /**
   * Minimum centicredits debited per action (protects against
   * fractional rounding). Default 1 cc = 0.01 displayed credit.
   */
  floor: Partial<Record<PricingCategory, number>>
}

/**
 * Core defaults — what every app gets if it doesn't register
 * overrides. Tuned for ~50%+ gross margin at pack-rate revenue.
 *
 * Adjusting these affects EVERY app — don't tweak without coordinating
 * across apps. Per-app drift goes through
 * `registerApp()`.
 */
export const DEFAULT_PRICING_MARKUP: Required<PricingMarkup["markup"]> = {
  image: 1.5,
  video: 1.6,
  audio: 1.5,
  text: 2.0,
  search: 2.0,
}

export const DEFAULT_PRICING_FLOORS: Required<PricingMarkup["floor"]> = {
  image: 1,
  video: 1,
  audio: 1,
  text: 1,
  search: 1,
}

/**
 * Registry of app-scoped pricing overrides. Defaults flow through when
 * an app doesn't register; partial overrides merge per-category.
 */
class PricingRegistry {
  private apps = new Map<string, PricingMarkup>()

  registerApp(appId: string, overrides: PricingMarkup): void {
    this.apps.set(appId, overrides)
  }

  unregisterApp(appId: string): void {
    this.apps.delete(appId)
  }

  getMarkup(category: PricingCategory, appId?: string): number {
    if (appId) {
      const app = this.apps.get(appId)
      const m = app?.markup[category]
      if (m !== undefined) return m
    }
    return DEFAULT_PRICING_MARKUP[category]
  }

  getFloor(category: PricingCategory, appId?: string): number {
    if (appId) {
      const app = this.apps.get(appId)
      const f = app?.floor[category]
      if (f !== undefined) return f
    }
    return DEFAULT_PRICING_FLOORS[category]
  }

  /** Resolve the full PricingMarkup for an app (with defaults filled in). */
  resolve(appId?: string): Required<PricingMarkup> {
    const markup = { ...DEFAULT_PRICING_MARKUP }
    const floor = { ...DEFAULT_PRICING_FLOORS }
    if (appId) {
      const app = this.apps.get(appId)
      if (app) {
        Object.assign(markup, app.markup)
        Object.assign(floor, app.floor)
      }
    }
    return { markup, floor }
  }
}

export const pricingRegistry = new PricingRegistry()

/**
 * Formula — turn provider USD cost into **centicredits**.
 *
 * Honors (in priority): `overrideCreditCost` → app markup → default
 * markup. Always applies the floor (in cc).
 *
 * Returns: cc per call (e.g. 53 cc = 0.53 displayed credits).
 */
export function computeCenticredits(args: {
  baseCostUsd: number
  category: PricingCategory
  /**
   * Per-model centicredit override. When set, bypasses the formula —
   * use for strategic deviations (subsidized adoption, partner
   * pricing). Unit: cc per call.
   */
  overrideCreditCost?: number
  appId?: string
}): number {
  if (typeof args.overrideCreditCost === "number") {
    return Math.max(
      pricingRegistry.getFloor(args.category, args.appId),
      args.overrideCreditCost
    )
  }
  const markup = pricingRegistry.getMarkup(args.category, args.appId)
  const floor = pricingRegistry.getFloor(args.category, args.appId)
  return Math.max(floor, Math.ceil((args.baseCostUsd * markup) / CC_USD_RATE))
}
