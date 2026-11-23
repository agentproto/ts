/** `canPay` and the journal agree on how far an account can be spent: down to a lot's floor, not only to zero. */
import type { WalletEvent } from "@agentproto/wallet"
import { describe, expect, it } from "vitest"
import { canPay, loadBillingManifestForTest } from "./cases-kit.js"
import { InMemoryStorage, ManualClock } from "../testing/index.js"

const T0 = Date.UTC(2026, 10, 20, 12, 0, 0)

function setup() {
  const clock = new ManualClock(T0)
  const storage = new InMemoryStorage(clock)
  const m = loadBillingManifestForTest("acme")
  const mint = (accountId: string, amount: number, extra: Partial<WalletEvent> = {}): WalletEvent => ({
    id: `mint:${accountId}:${amount}:${String(extra.floor)}`,
    accountId,
    kind: "mint",
    asset: m.primaryAsset,
    partitionId: m.derived.partitions.keys().next().value as string,
    restriction: [],
    amount,
    lotId: `lot:${accountId}`,
    occurredAt: T0,
    ...extra,
  })
  const burn = (accountId: string, amount: number, id: string): WalletEvent => ({
    ...mint(accountId, amount),
    id,
    kind: "burn",
  })
  return { m, storage, mint, burn }
}

describe("canPay with lot floors", () => {
  it("a lot with no floor can be spent down to zero and not below", async () => {
    const { m, storage, mint } = setup()
    await storage.commit("a", [mint("a", 1_000)])
    expect(await canPay(m, storage, "a", 1_000, T0)).toBe(true)
    expect(await canPay(m, storage, "a", 1_001, T0)).toBe(false)
  })

  it("a bounded short lot can be spent down to its floor, as the journal allows", async () => {
    const { m, storage, mint, burn } = setup()
    await storage.commit("a", [mint("a", 0, { floor: -5_000 })])
    expect(await canPay(m, storage, "a", 5_000, T0)).toBe(true)
    expect(await canPay(m, storage, "a", 5_001, T0)).toBe(false)
    // The journal agrees: the spend the check allows commits, one more is refused.
    await storage.commit("a", [burn("a", 5_000, "b1")])
    expect(await canPay(m, storage, "a", 1, T0)).toBe(false)
    await expect(storage.commit("a", [burn("a", 1, "b2")])).rejects.toThrow(/overdraw/)
  })

  it("the headroom is counted from what is already borrowed", async () => {
    const { m, storage, mint, burn } = setup()
    await storage.commit("a", [mint("a", 100, { floor: -1_000 })])
    await storage.commit("a", [burn("a", 600, "b1")]) // remaining -500
    expect(await canPay(m, storage, "a", 500, T0)).toBe(true)
    expect(await canPay(m, storage, "a", 501, T0)).toBe(false)
  })

  it("an unbounded short lot can always pay", async () => {
    const { m, storage, mint } = setup()
    await storage.commit("a", [mint("a", 0, { floor: null })])
    expect(await canPay(m, storage, "a", 10 ** 12, T0)).toBe(true)
  })
})
