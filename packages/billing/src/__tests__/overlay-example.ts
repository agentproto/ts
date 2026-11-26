/**
 * Worked example: a host's own billing rules written as a thin layer over the
 * kit's primitives. The rules here are made up (a daily cap, a bonus on a
 * pack, refuse-when-short); they are NOT in the kit. The kit gives `price`,
 * `debit` and the journal; the layer decides when to call them and with what.
 * `README.md` ("Writing an overlay") explains the shape; `overlay-example.test.ts` runs it.
 */
import type { WalletEvent } from "@agentproto/wallet"
import type { ClockPort, StoragePort } from "@agentproto/wallet/ports"
import type { BillingHandle } from "../define-billing-manifest.js"
import { createDebit, createPricer, type UsageConfig, type UsageEvent } from "../spend/index.js"

/** The layer's own configuration. Changing a rule is changing this object, not the kit. */
export interface OverlayPolicy {
  /** The most one account may be charged in a rolling day, minor units. */
  dailyCapMinor: number
  /** A bonus lot minted on top of a pack, as a percent of the pack. */
  packBonusPercent: number
  /** What a charge does when the account is short. */
  onShortfall: "refuse" | "absorb"
}

export type OverlayCharge =
  | { ok: true; charged: number; priceMinor: number; replayed: boolean }
  | { ok: false; reason: "capped" | "insufficient_funds" | "unpriced" }

const DAY_MS = 86_400_000

export function createOverlay(deps: { manifest: BillingHandle; usage: UsageConfig; storage: StoragePort; clock: ClockPort; asset: string; policy: OverlayPolicy }) {
  const { manifest, usage, storage, clock, asset, policy } = deps
  const pricer = createPricer({ manifest, usage })
  const debit = createDebit({ storage, clock }, { asset })

  async function spentToday(accountId: string): Promise<number> {
    const since = clock.nowMs() - DAY_MS
    return (await storage.loadEvents(accountId)).filter(e => e.kind === "burn" && e.occurredAt > since).reduce((s, e) => s + e.amount, 0)
  }

  return {
    /** Price an event with the kit, apply the layer's cap, then debit with the kit. */
    async charge(event: UsageEvent): Promise<OverlayCharge> {
      let priceMinor: number
      try {
        priceMinor = pricer.price(event).minor
      } catch {
        return { ok: false, reason: "unpriced" }
      }
      if ((await spentToday(event.accountId)) + priceMinor > policy.dailyCapMinor) return { ok: false, reason: "capped" }
      const r = await debit.debit({ accountId: event.accountId, key: event.key, amount: priceMinor, shortfall: policy.onShortfall })
      return r.ok ? { ok: true, charged: r.charged, priceMinor, replayed: r.replayed } : { ok: false, reason: "insufficient_funds" }
    },

    /** Mint the layer's bonus lot for a pack. One lot per `packKey`: a replay writes nothing. */
    async grantPackBonus(accountId: string, packKey: string, packMinor: number): Promise<number> {
      const bonus = Math.floor((packMinor * policy.packBonusPercent) / 100)
      if (bonus <= 0) return 0
      const id = `bonus:${packKey}`
      if ((await storage.loadEvents(accountId)).some(e => e.id === id)) return 0
      const ev: WalletEvent = { id, accountId, kind: "mint", asset, partitionId: "main", restriction: ["unearned"], amount: bonus, lotId: id, correlationId: packKey, occurredAt: clock.nowMs() }
      await storage.commit(accountId, [ev])
      return bonus
    },
  }
}
