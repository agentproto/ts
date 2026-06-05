import { describe, it, expect } from "vitest"
import { defineAsset } from "../define-asset.js"
import type { AssetDeclaration } from "../asset.js"
import type { PartitionSpec } from "../partition.js"
import {
  fold,
  spendableBalance,
  balanceByAsset,
  type Lot,
  type WalletEvent,
} from "../fold.js"
import { selectLotsForSpend } from "../coalescing.js"
import type { StoragePort } from "../ports/storage.port.js"
import { UNRESTRICTED } from "../restriction-lattice.js"

/**
 * Minimal in-memory StoragePort — folds the journal on every read and rejects a
 * commit that would drive any lot's (remaining − reserved) below 0. Mirrors what
 * the Postgres adapter must enforce, serialized per account.
 */
class InMemoryStorage implements StoragePort {
  private journals = new Map<string, WalletEvent[]>()
  constructor(private readonly now: number) {}

  async loadEvents(accountId: string): Promise<WalletEvent[]> {
    return [...(this.journals.get(accountId) ?? [])]
  }
  async loadLots(accountId: string): Promise<Lot[]> {
    return fold(this.journals.get(accountId) ?? [], this.now)
  }
  async commit(accountId: string, events: readonly WalletEvent[]): Promise<void> {
    const next = [...(this.journals.get(accountId) ?? []), ...events]
    for (const lot of fold(next, this.now)) {
      if (lot.remaining - lot.reserved < 0) {
        throw new Error(`overdraw on lot ${lot.id}`)
      }
    }
    this.journals.set(accountId, next)
  }
  async spendableBalance(accountId: string, asset: string): Promise<number> {
    return spendableBalance(fold(this.journals.get(accountId) ?? [], this.now), asset, this.now)
  }
}

const CREDIT = defineAsset({
  ref: "GUILDE_CREDITS",
  name: "Guilde Credits",
  symbol: "GCR",
  decimals: 2,
  standard: "internal",
  ruleSet: { settleOut: false, spendableOn: ["*"], convertEdges: [], transfer: "internal" },
})

const partitions = new Map<string, PartitionSpec>([
  ["GUILDE_CREDITS:general", { id: "GUILDE_CREDITS:general", asset: "GUILDE_CREDITS", restriction: UNRESTRICTED }],
])

const NOW = 10_000

describe("defineAsset", () => {
  it("accepts a well-formed declaration and freezes it", () => {
    expect(CREDIT.ref).toBe("GUILDE_CREDITS")
    expect(Object.isFrozen(CREDIT)).toBe(true)
  })
  it("rejects a lowercase ref", () => {
    expect(() =>
      defineAsset({ ...CREDIT, ref: "guilde_credits" } as AssetDeclaration),
    ).toThrow(/invalid id/)
  })
  it("rejects a self-referential convert edge", () => {
    expect(() =>
      defineAsset({
        ...CREDIT,
        ruleSet: { ...CREDIT.ruleSet, convertEdges: [{ to: "GUILDE_CREDITS", rate: { kind: "fixed", ratio: 1 } }] },
      } as AssetDeclaration),
    ).toThrow(/edge to itself/)
  })
})

describe("grant → spend roundtrip via StoragePort", () => {
  it("mints, spends passively, and the reconciliation oracle holds", async () => {
    const store = new InMemoryStorage(NOW)
    const acct = "acct-1"

    // grant 500.00 credits (mint)
    await store.commit(acct, [
      {
        id: "e-mint", accountId: acct, kind: "mint", asset: "GUILDE_CREDITS",
        partitionId: "GUILDE_CREDITS:general", restriction: UNRESTRICTED,
        amount: 50000, lotId: "L1", intent: "passive", occurredAt: NOW,
      },
    ])
    expect(await store.spendableBalance(acct, "GUILDE_CREDITS")).toBe(50000)

    // spend 120.00 passively — route via coalescing, emit burns
    const lots = await store.loadLots(acct)
    const plan = selectLotsForSpend(
      lots, { asset: "GUILDE_CREDITS", category: "text", amount: 12000, now: NOW }, CREDIT, partitions,
    )
    expect(plan.shortfall).toBe(0)
    await store.commit(
      acct,
      plan.draws.map((d, i) => ({
        id: `e-burn-${i}`, accountId: acct, kind: "burn" as const, asset: "GUILDE_CREDITS",
        partitionId: "GUILDE_CREDITS:general", restriction: UNRESTRICTED,
        amount: d.amount, lotId: d.lotId, intent: "passive" as const, occurredAt: NOW,
      })),
    )
    expect(await store.spendableBalance(acct, "GUILDE_CREDITS")).toBe(38000)

    // reconciliation oracle: replay(journal) == projection balance
    const events = await store.loadEvents(acct)
    const replayed = balanceByAsset(fold(events, NOW), NOW).get("GUILDE_CREDITS")
    expect(replayed).toBe(38000)
  })

  it("rejects an overdraw at commit", async () => {
    const store = new InMemoryStorage(NOW)
    const acct = "acct-2"
    await store.commit(acct, [
      {
        id: "e-mint", accountId: acct, kind: "mint", asset: "GUILDE_CREDITS",
        partitionId: "GUILDE_CREDITS:general", restriction: UNRESTRICTED,
        amount: 100, lotId: "L1", occurredAt: NOW,
      },
    ])
    await expect(
      store.commit(acct, [
        {
          id: "e-burn", accountId: acct, kind: "burn", asset: "GUILDE_CREDITS",
          partitionId: "GUILDE_CREDITS:general", restriction: UNRESTRICTED,
          amount: 250, lotId: "L1", occurredAt: NOW,
        },
      ]),
    ).rejects.toThrow(/overdraw/)
  })
})
