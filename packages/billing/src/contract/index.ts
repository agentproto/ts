/**
 * Contract tests for the spend primitives: the invariants no rule, hook or
 * overlay can lift. A host that builds on the kit (its own rules, its own
 * storage adapter) runs these cases in its CI, and again at every bump of the
 * kit version. Framework-free: each case is `{ name, run }` and throws on
 * failure.
 *
 *   import { spendContractCases } from "@agentproto/billing/contract-tests"
 *   for (const c of spendContractCases({ ...ctx })) it(c.name, c.run)
 *
 * The cases run against the host's real `StoragePort` (through `stores`), with
 * the kit's own debit, pricer and shadow: they prove the storage adapter and
 * the wiring keep the invariants, not the host's rule values.
 */
import type { WalletEvent } from "@agentproto/wallet"
import type { StoragePort } from "@agentproto/wallet/ports"
import type { BillingHandle } from "../define-billing-manifest.js"
import { createDebit, createPricer, createShadow, UnpricedUsageError, type DebitRule, type UsageConfig } from "../spend/index.js"
import type { ConformanceCase } from "../testing/conformance.js"
import type { ManualClock } from "../testing/fakes.js"

export type { ConformanceCase }

export interface SpendContractContext {
  /** A fresh, empty journal for one case. */
  stores: () => { storage: StoragePort }
  /** A clock the cases may move. */
  clock: ManualClock
  /** A manifest with a primary asset and an anchor (any: the kit's reference manifest works). */
  manifest: BillingHandle
}

const T0 = Date.UTC(2026, 10, 20, 12, 0, 0)

class ContractError extends Error {}
const check = (cond: unknown, msg: string): void => {
  if (!cond) throw new ContractError(msg)
}
const eq = (a: unknown, b: unknown, msg: string): void => check(Object.is(a, b), `${msg}: expected ${String(b)}, got ${String(a)}`)

export function spendContractCases(ctx: SpendContractContext): ConformanceCase[] {
  const asset = ctx.manifest.primaryAsset
  const cases: ConformanceCase[] = []
  const add = (name: string, run: () => Promise<void>) => cases.push({ name: `SPEND-CONTRACT ${name}`, run })

  async function world(balance: number, extra: Partial<WalletEvent> = {}, rules: readonly DebitRule[] = []) {
    ctx.clock.set(T0)
    const { storage } = ctx.stores()
    if (balance > 0 || extra.floor !== undefined) {
      await storage.commit("acct", [{ id: "mint:1", accountId: "acct", kind: "mint", asset, partitionId: "main", restriction: [], amount: balance, lotId: "lot1", occurredAt: T0, ...extra }])
    }
    const debit = createDebit({ storage, clock: ctx.clock }, { asset, rules })
    const burns = async () => (await storage.loadEvents("acct")).filter(e => e.kind === "burn")
    return { storage, debit, burns, balance: () => storage.spendableBalance("acct", asset) }
  }

  // ── idempotence ─────────────────────────────────────────────────
  add("a key charges once: a replay and concurrent calls write one burn", async () => {
    const w = await world(1_000)
    await Promise.all([1, 2, 3].map(() => w.debit.debit({ accountId: "acct", key: "k1", amount: 100, shortfall: "refuse" })))
    const again = await w.debit.debit({ accountId: "acct", key: "k1", amount: 100, shortfall: "refuse" })
    check(again.ok && again.replayed, "the replay is reported as a replay")
    eq(await w.balance(), 900, "balance after one charge")
    eq((await w.burns()).length, 1, "burn events")
  })
  add("a replay with another amount returns the first charge and writes nothing", async () => {
    const w = await world(1_000)
    await w.debit.debit({ accountId: "acct", key: "k1", amount: 100, shortfall: "refuse" })
    const r = await w.debit.debit({ accountId: "acct", key: "k1", amount: 900, shortfall: "refuse" })
    check(r.ok && r.charged === 100, "first charge returned")
    eq(await w.balance(), 900, "balance")
  })

  // ── no overdraw ─────────────────────────────────────────────────
  add("a prepaid lot never goes below zero, whatever the amount or the shortfall mode", async () => {
    const w = await world(100)
    await w.debit.debit({ accountId: "acct", key: "a", amount: 1_000_000, shortfall: "absorb" })
    eq(await w.balance(), 0, "balance after absorbing an oversized charge")
    const r = await w.debit.debit({ accountId: "acct", key: "b", amount: 10, shortfall: "refuse" })
    check(!r.ok && r.reason === "insufficient_funds", "refused when empty")
  })
  add("refuse writes nothing when the account cannot cover the amount", async () => {
    const w = await world(300)
    const r = await w.debit.debit({ accountId: "acct", key: "a", amount: 400, shortfall: "refuse" })
    check(!r.ok && r.reason === "insufficient_funds", "refused")
    eq((await w.burns()).length, 0, "burn events")
    eq(await w.balance(), 300, "balance")
  })
  add("a lot with a negative floor is drawn down to its floor and no further", async () => {
    const w = await world(0, { floor: -500 })
    const first = await w.debit.debit({ accountId: "acct", key: "a", amount: 400, shortfall: "refuse" })
    check(first.ok && first.charged === 400, "within the floor")
    const second = await w.debit.debit({ accountId: "acct", key: "b", amount: 400, shortfall: "refuse" })
    check(!second.ok, "past the floor is refused")
    const third = await w.debit.debit({ accountId: "acct", key: "c", amount: 400, shortfall: "absorb" })
    check(third.ok && third.charged === 100, "absorb stops at the floor")
  })

  // ── rules decide, the core executes ─────────────────────────────
  add("a rule can only lower the amount: raising it, zero or a fraction is refused and writes nothing", async () => {
    for (const amount of [900, 0, 12.5, Number.NaN]) {
      const w = await world(1_000, {}, [{ name: "bad", decide: () => ({ amount }) }])
      const r = await w.debit.debit({ accountId: "acct", key: "a", amount: 100, shortfall: "refuse" })
      check(!r.ok && r.reason === "invalid_decision" && r.rule === "bad", `amount ${amount} is an invalid decision`)
      eq((await w.burns()).length, 0, "burn events")
    }
  })
  add("a rule that lowers the amount is executed, and the result names the rule", async () => {
    const w = await world(1_000, {}, [{ name: "cap", decide: () => ({ amount: 40 }) }])
    const r = await w.debit.debit({ accountId: "acct", key: "a", amount: 100, shortfall: "refuse" })
    check(r.ok && r.charged === 40 && r.decidedBy === "cap", "charged 40, decided by cap")
  })
  add("a rule that lowers the amount hands it to the next rule, so order does not hide a refusal", async () => {
    const w = await world(1_000, {}, [
      { name: "max-50", decide: c => (c.requested > 50 ? { amount: 50 } : undefined) },
      { name: "no-over-30", decide: c => (c.requested > 30 ? { refuse: "over 30" } : undefined) },
    ])
    const r = await w.debit.debit({ accountId: "acct", key: "a", amount: 100, shortfall: "refuse" })
    check(!r.ok && r.reason === "refused_by_rule" && r.rule === "no-over-30", "the second rule saw 50 and refused")
    eq((await w.burns()).length, 0, "burn events")
  })
  add("a rule that answers something else than undefined, { refuse } or { amount } refuses the spend", async () => {
    for (const bad of [null, 0, false, "", { foo: 1 }]) {
      const w = await world(1_000, {}, [{ name: "odd", decide: () => bad as never }])
      const r = await w.debit.debit({ accountId: "acct", key: "a", amount: 100, shortfall: "refuse" })
      check(!r.ok && r.reason === "invalid_decision", `${JSON.stringify(bad)} is refused`)
      eq((await w.burns()).length, 0, "burn events")
    }
  })
  add("rules run in order, a refusal stops the run, the trace shows who passed", async () => {
    const w = await world(1_000, {}, [
      { name: "first", decide: () => undefined },
      { name: "second", decide: () => ({ refuse: "no" }) },
      { name: "third", decide: () => ({ amount: 1 }) },
    ])
    const r = await w.debit.debit({ accountId: "acct", key: "a", amount: 100, shortfall: "refuse" })
    check(!r.ok && r.reason === "refused_by_rule" && r.rule === "second", "second refused")
    eq(JSON.stringify(r.trace), JSON.stringify([{ rule: "first", outcome: "pass" }, { rule: "second", outcome: "decided" }]), "trace")
    eq((await w.burns()).length, 0, "burn events")
  })
  add("a rule that throws refuses the spend", async () => {
    const w = await world(1_000, {}, [{ name: "boom", decide: () => { throw new Error("x") } }])
    const r = await w.debit.debit({ accountId: "acct", key: "a", amount: 100, shortfall: "refuse" })
    check(!r.ok && r.reason === "rule_error" && r.rule === "boom", "refused with rule_error")
    eq(await w.balance(), 1_000, "balance")
  })
  add("a rule gets a frozen snapshot: it cannot write the journal", async () => {
    let attempt = "none"
    const w = await world(1_000, {}, [{
      name: "meddler",
      decide: ctx2 => {
        try { (ctx2.history as WalletEvent[]).push({} as WalletEvent); attempt = "pushed" } catch { attempt = "blocked" }
        try { (ctx2.history[0]!.restriction as string[]).push("x"); attempt += "+nested" } catch { attempt += "+nested-blocked" }
        try { (ctx2 as { requested: number }).requested = 1; attempt += "+mutated" } catch { attempt += "+blocked" }
        return undefined
      },
    }])
    await w.debit.debit({ accountId: "acct", key: "a", amount: 100, shortfall: "refuse" })
    eq(attempt, "blocked+nested-blocked+blocked", "mutation attempts")
    eq((await w.storage.loadEvents("acct")).length, 2, "journal: one mint, one burn")
  })

  // ── price and shadow ────────────────────────────────────────────
  const usage: UsageConfig = { defaults: { margin: 3 }, categories: [{ id: "llm", match: { kind: "llm" }, cost: { source: "measured" }, margin: 2 }, { id: "fee", match: { kind: "fee" }, cost: { source: "measured" }, margin: "at-cost" }] }
  add("an event no category prices fails closed, never zero", async () => {
    const p = createPricer({ manifest: ctx.manifest, usage })
    let reason = "none"
    try { p.price({ kind: "video", key: "k", accountId: "acct", providerCost: { amount: 1, currency: "USD" } }) } catch (e) { reason = e instanceof UnpricedUsageError ? e.reason : "other" }
    eq(reason, "no-category", "reason")
  })
  add("at-cost is margin 1 and the defaults do not override it", async () => {
    const p = createPricer({ manifest: ctx.manifest, usage })
    const r = p.price({ kind: "fee", key: "k", accountId: "acct", providerCost: { amount: 1, currency: "USD" } })
    check(r.atCost && r.margin === 1 && Math.abs((r.realMargin ?? 0) - 1) < 1e-6, "margin 1")
  })
  add("shadow never touches the journal and never turns an unpriced event into a free one", async () => {
    ctx.clock.set(T0)
    const { storage } = ctx.stores()
    const seen: string[] = []
    const shadow = createShadow({ pricer: createPricer({ manifest: ctx.manifest, usage }), sink: { write: e => void seen.push(e.status) } })
    await shadow.record({ kind: "llm", key: "k1", accountId: "acct", providerCost: { amount: 1, currency: "USD" } })
    await shadow.record({ kind: "video", key: "k2", accountId: "acct", providerCost: { amount: 1, currency: "USD" } })
    eq(seen.join(","), "priced,unpriced", "recorded entries")
    eq((await storage.loadEvents("acct")).length, 0, "journal events")
  })

  return cases
}
