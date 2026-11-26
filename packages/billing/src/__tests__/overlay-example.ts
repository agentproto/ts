/**
 * Worked example: a host's own billing rules written as a thin layer over the
 * kit's primitives. The rules are made up (a rolling-day cap, a per-call
 * maximum); they are NOT in the kit. Each rule is a PURE function that looks
 * at a read-only snapshot and decides (refuse, or lower the amount); the kit's
 * `debit` runs them in order and executes the result, so a rule can never write
 * the journal, double-charge a key or raise an amount.
 *
 * What is deliberately NOT a rule here: a bonus on a pack and an expiry are
 * data in `BILLING.md` (`conversions[].bonus`, `expires`), executed by the
 * kit's payment path, and the draw order is the kit's default.
 * Order matters: `per-call-max` lowers the amount and hands it on, a later
 * refusal would see the lowered amount. `README.md` ("Writing an overlay") explains the shape; `overlay-example.test.ts` runs it.
 */
import type { ClockPort, StoragePort } from "@agentproto/wallet/ports"
import type { BillingHandle } from "../define-billing-manifest.js"
import { createDebit, createPricer, type DebitResult, type DebitRule, type UsageConfig, type UsageEvent } from "../spend/index.js"

/** The layer's own configuration. Changing a rule is changing this object, not the kit. */
export interface OverlayPolicy {
  /** The most one account may be charged in a rolling day, minor units. */
  dailyCapMinor: number
  /** The most one call may cost, minor units. */
  perCallMaxMinor: number
  /** What a charge does when the account is short. */
  onShortfall: "refuse" | "absorb"
}

const DAY_MS = 86_400_000

/** The layer's rules, in the order they apply. Pure: they read `ctx`, they return a decision. */
export function overlayRules(policy: OverlayPolicy): DebitRule[] {
  return [
    {
      name: "daily-cap",
      decide: ctx => {
        const since = ctx.now - DAY_MS
        const spent = ctx.history.filter(e => e.kind === "burn" && e.occurredAt > since).reduce((s, e) => s + e.amount, 0)
        return spent + ctx.requested > policy.dailyCapMinor ? { refuse: "daily cap reached" } : undefined
      },
    },
    { name: "per-call-max", decide: ctx => (ctx.requested > policy.perCallMaxMinor ? { amount: policy.perCallMaxMinor } : undefined) },
  ]
}

export function createOverlay(deps: { manifest: BillingHandle; usage: UsageConfig; storage: StoragePort; clock: ClockPort; asset: string; policy: OverlayPolicy }) {
  const { manifest, usage, storage, clock, asset, policy } = deps
  const pricer = createPricer({ manifest, usage })
  const debit = createDebit({ storage, clock }, { asset, rules: overlayRules(policy) })
  return {
    /** Price with the kit, then debit with the kit under the layer's rules. */
    async charge(event: UsageEvent): Promise<DebitResult | { ok: false; reason: "unpriced" }> {
      let priceMinor: number
      try {
        priceMinor = pricer.price(event).minor
      } catch {
        return { ok: false, reason: "unpriced" }
      }
      return debit.debit({ accountId: event.accountId, key: event.key, amount: priceMinor, shortfall: policy.onShortfall })
    },
  }
}
