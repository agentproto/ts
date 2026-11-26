/**
 * BILL-USE-* conformance cases (AIP-74, rules 29 to 35), framework-free like the
 * BILL-* cases: a name and an async function that throws on failure.
 *
 *   for (const c of billingUsageConformanceCases(ctx)) it(c.name, c.run)
 *
 * They run on a manifest the host passes (any with a primary asset and an
 * anchor) and compute their expectations from the manifest's own anchor, so
 * they check the price function and the shadow guarantees, not a host's
 * values. The invariants of money (rules 36 to 40: one key charges once, no
 * raising, never below the floor, fail closed, named rules) are the contract
 * tests of `@agentproto/billing/contract-tests`.
 */
import type { StoragePort } from "@agentproto/wallet/ports"
import type { BillingHandle } from "../define-billing-manifest.js"
import { entryRatio } from "../rate.js"
import { assertMarginFloors, createPricer, createShadow, usageProblems, UnpricedUsageError, usageReport, type ShadowEntry, type UsageConfig } from "../spend/index.js"
import type { ConformanceCase } from "./conformance.js"

export interface UsageConformanceContext {
  /** The manifest under test: a primary asset and an anchor. */
  manifest: BillingHandle
  /** A fresh, empty journal, for the case that checks `shadow` moves no balance. Optional. */
  stores?: () => { storage: StoragePort }
}

class UsageConformanceError extends Error {}
const check = (c: unknown, msg: string): void => {
  if (!c) throw new UsageConformanceError(msg)
}
const throws = (fn: () => unknown, msg: string): void => {
  try {
    fn()
  } catch {
    return
  }
  throw new UsageConformanceError(msg)
}

export function billingUsageConformanceCases(ctx: UsageConformanceContext): ConformanceCase[] {
  const m = ctx.manifest
  const decimals = m.derived.assets.get(m.primaryAsset)?.decimals ?? 0
  const anchor = m.anchor.currency
  // Minor units of 1 unit of cost in `currency` at margin 1 (rule 30), from the manifest's own anchor and fx.
  const minorOf = (currency: string): number => (entryRatio(m, currency) ?? NaN) * 10 ** decimals
  const cfg = (usage: UsageConfig) => createPricer({ manifest: m, usage })
  const ev = (key: string, over: Record<string, unknown> = {}) => ({ kind: "llm", key, accountId: "a", ...over }) as never
  const cost = (amount: number, currency = anchor) => ({ amount, currency })
  const add = (name: string, run: () => Promise<void>): ConformanceCase => ({ name, run })

  const cases: ConformanceCase[] = [
    add("BILL-USE-29 of the categories that match, the one with the most match fields wins", async () => {
      const p = cfg({ categories: [
        { id: "any", cost: { source: "measured" } },
        { id: "by-kind", match: { kind: "llm" }, cost: { source: "measured" } },
        { id: "by-kind-model", match: { kind: "llm", model: "m1" }, cost: { source: "measured" } },
      ] })
      check(p.price(ev("k", { model: "m1", providerCost: cost(1) })).categoryId === "by-kind-model", "the most specific category did not win")
      check(p.price(ev("k", { model: "m2", providerCost: cost(1) })).categoryId === "by-kind", "the kind category did not win over the catch-all")
      check(p.price(ev("k", { kind: "tts", providerCost: cost(1) })).categoryId === "any", "the catch-all did not catch")
    }),
    add("BILL-USE-30 the price is max(floorMinor, ceil(cost x ratio x margin x 10^decimals)); an absent margin is 1, an absent floor is 0", async () => {
      const p = cfg({ categories: [{ id: "x2", match: { kind: "llm" }, cost: { source: "measured" }, margin: 2 }, { id: "plain", match: { kind: "tts" }, cost: { source: "measured" } }, { id: "floored", match: { kind: "stt" }, cost: { source: "measured" }, floorMinor: 7 }] })
      const one = minorOf(anchor)
      check(p.price(ev("a", { providerCost: cost(1) })).minor === Math.ceil(one * 2 - 1e-9), "1 unit of cost at margin 2 is not 2 x the entry ratio")
      check(p.price(ev("b", { kind: "tts", providerCost: cost(1) })).minor === Math.ceil(one - 1e-9), "an absent margin is not 1")
      check(p.price(ev("c", { kind: "stt", providerCost: cost(0) })).minor === 7, "the floor does not hold a zero cost up")
      check(p.price(ev("d", { kind: "tts", providerCost: cost(0) })).minor === 0, "an absent floor is not 0")
    }),
    add("BILL-USE-30 a category cannot write its own rate", async () => {
      check(usageProblems(m, { categories: [{ id: "r", cost: { source: "measured" }, rate: 3 } as never] }).length > 0, "a category with its own rate was accepted")
      throws(() => cfg({ categories: [{ id: "r", cost: { source: "measured" }, creditsPerUnit: 3 } as never] }), "createPricer built from a category with a rate")
    }),
    add("BILL-USE-30 a cost in another declared currency uses the fx of the manifest", async () => {
      const other = Object.keys(m.fx ?? {}).find(c => c !== anchor)
      if (!other) return
      const p = cfg({ categories: [{ id: "c", cost: { source: "measured" } }] })
      check(p.price(ev("a", { providerCost: cost(1, other) })).minor === Math.ceil(minorOf(other) - 1e-9), `1 ${other} is not priced with the manifest's fx`)
    }),
    add("BILL-USE-31 at-cost is margin 1: defaults.margin does not override it, an event carries no margin, at-cost with a marginFloor above 1 is refused", async () => {
      const p = cfg({ defaults: { margin: 5 }, categories: [{ id: "fee", match: { kind: "fee" }, cost: { source: "measured" }, margin: "at-cost" }, { id: "rest", cost: { source: "measured" } }] })
      const r = p.price(ev("a", { kind: "fee", margin: 9, providerCost: cost(1) }))
      check(r.margin === 1 && r.atCost && r.minor === Math.ceil(minorOf(anchor) - 1e-9), "at-cost was overridden")
      check(p.price(ev("b", { kind: "other", providerCost: cost(1) })).margin === 5, "defaults.margin does not apply to a plain category")
      check(usageProblems(m, { categories: [{ id: "f", cost: { source: "measured" }, margin: "at-cost", marginFloor: 1.5 }] }).length > 0, "at-cost with a marginFloor above 1 was accepted")
    }),
    add("BILL-USE-32 an event no category prices, with no cost, an unknown currency, a negative or non-finite cost or negative units is refused, never priced at zero", async () => {
      const refused = (usage: UsageConfig, e: unknown, reason: string) => {
        try {
          cfg(usage).price(e as never)
        } catch (err) {
          check(err instanceof UnpricedUsageError && err.reason === reason, `expected '${reason}', got ${String(err)}`)
          return
        }
        throw new UsageConformanceError(`an unpriced event was priced (${reason})`)
      }
      const u: UsageConfig = { categories: [{ id: "llm", match: { kind: "llm" }, cost: { source: "measured" } }] }
      refused(u, ev("a", { kind: "nothing", providerCost: cost(1) }), "no-category")
      refused(u, ev("b"), "no-cost")
      refused(u, ev("c", { providerCost: cost(1, "ZZZ") }), "unknown-currency")
      refused(u, ev("d", { providerCost: cost(-1) }), "invalid-cost")
      refused(u, ev("e", { providerCost: cost(Number.NaN) }), "invalid-cost")
      refused(u, ev("f", { providerCost: cost(1), units: -1 }), "invalid-units")
    }),
    add("BILL-USE-35 a category that sells under its marginFloor fails the check; at-cost is checked against 1", async () => {
      const ok = cfg({ categories: [{ id: "a", cost: { source: "measured" }, margin: 2, marginFloor: 1.5 }] })
      assertMarginFloors(ok, [ev("a", { providerCost: cost(1) })])
      const bad = cfg({ categories: [{ id: "a", cost: { source: "measured" }, margin: 1, marginFloor: 1.5 }] })
      throws(() => assertMarginFloors(bad, [ev("a", { providerCost: cost(1) })]), "a category selling under its floor passed")
    }),
    add("BILL-USE-35 shadow prices outside the journal, records an unpriced event as such and raises it", async () => {
      const written: ShadowEntry[] = []
      const alerts: string[] = []
      const p = cfg({ categories: [{ id: "llm", match: { kind: "llm" }, cost: { source: "measured" } }] })
      const s = createShadow({ pricer: p, sink: { write: e => void written.push(e) }, alert: e => void alerts.push(e.reason) })
      const a = await s.record(ev("a", { providerCost: cost(1) }))
      const b = await s.record(ev("b", { kind: "nothing" }))
      check(a.status === "priced" && b.status === "unpriced", "shadow statuses are wrong")
      check(written.length === 2 && alerts.length === 1, "an unpriced event was not recorded and raised")
      const rep = usageReport(written)
      check(rep.unpriced.events === 1 && rep.lines.length === 1, "the report does not show the unpriced event")
      throws(() => createShadow({} as never), "a shadow with no pricer started")
      if (ctx.stores) {
        const { storage } = ctx.stores()
        await s.record(ev("c", { providerCost: cost(1) }))
        check((await storage.loadEvents("a")).length === 0, "shadow wrote to the journal")
      }
    }),
  ]
  return cases
}
