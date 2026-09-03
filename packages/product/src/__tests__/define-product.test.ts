import { describe, it, expect } from "vitest"
import { defineProduct, attachPricing, collectPriced } from "../index.js"
import { createRegistry } from "@agentproto/registry"
import { refFor, RefCatalog, type ArtifactRef } from "@agentproto/ref-catalog"
import { defineApp, type AppHandle } from "@agentproto/app-kit"
import { definePack, type PackHandle } from "@agentproto/pack"
import { defineTool } from "@agentproto/tool"

// Hypothetical AIP-61 sandbox — a future AIP with ZERO pricing awareness.
interface SandboxHandle {
  readonly id: string
  readonly provider: string
}
const defineSandbox = (d: SandboxHandle): SandboxHandle => Object.freeze({ ...d })

const appSpec = { aip: 42, keyBy: (h: AppHandle) => h.id! }
const packSpec = { aip: 52, keyBy: (h: PackHandle) => h.name }
const sandboxSpec = { aip: 61, keyBy: (h: SandboxHandle) => h.id }
const toolSpec = { aip: 14, keyBy: (h: { id: string }) => h.id }

/** Fixtures mirroring the dogfood that shaped the design. */
function buildWorld() {
  const app = defineApp({
    id: "book-companion",
    name: "Book Companion",
    description: "companion app",
    ui: { html: "<h1>x</h1>" },
  })
  const pack = definePack({
    schema: "pack/v1",
    name: "the-agentic-coder",
    title: "The Agentic Coder",
    description: "bundle",
    version: "1.0.0",
    plugin: { inline: true },
    pricing: { bundle: 49 }, // legacy AIP-52 pricing — deliberately ignored by the capability
  })
  const sandbox = defineSandbox({ id: "e2b-main", provider: "e2b" })
  const tool = defineTool({ id: "search-web", name: "search-web", description: "web search" })

  const cat = new RefCatalog()
  const apps = createRegistry<AppHandle>({ family: "app", keyBy: h => h.id! })
  apps.register(app)
  cat.registerFamily<AppHandle>(42, { family: "app", keyBy: h => h.id! }, apps)
  const packs = createRegistry<PackHandle>({ family: "pack", keyBy: h => h.name })
  packs.register(pack)
  cat.registerFamily<PackHandle>(52, { family: "pack", keyBy: h => h.name }, packs)
  const sandboxes = createRegistry<SandboxHandle>({ family: "sandbox", keyBy: h => h.id })
  sandboxes.register(sandbox)
  cat.registerFamily<SandboxHandle>(61, { family: "sandbox", keyBy: h => h.id }, sandboxes)
  const tools = createRegistry<{ id: string }>({ family: "tool", keyBy: h => h.id })
  tools.register(tool)
  cat.registerFamily<{ id: string }>(14, { family: "tool", keyBy: h => h.id }, tools)

  return { cat, app, pack, sandbox, tool }
}

describe("ONE pricing mechanism across four artifact kinds", () => {
  it("attaches pricing to app, pack, sandbox, tool — zero per-kind fields", () => {
    const { app, pack, sandbox, tool } = buildWorld()
    const caps = [
      attachPricing(refFor({ aip: 42, keyBy: (h: AppHandle) => h.id! }, app), {
        model: "one-time",
        amountMinor: 4900,
        currency: "usd",
      }),
      attachPricing(refFor(packSpec, pack), {
        model: "prepaid-pool",
        unitPriceMinor: 5,
        currency: "usd",
        grantUnits: 200,
      }),
      attachPricing(refFor(sandboxSpec, sandbox), {
        model: "pay-per-call",
        unitPriceMinor: 1,
        currency: "usd",
        meter: "sandbox-hour",
      }),
      attachPricing(refFor(toolSpec, tool), {
        model: "pay-per-call",
        unitPriceMinor: 2,
        currency: "usd",
        meter: "tool-call",
      }),
    ]
    expect(caps).toHaveLength(4)
    expect(new Set(caps.map(c => c.on.aip))).toEqual(new Set([42, 52, 61, 14]))
  })

  it("the target AIP never learns about pricing — sandbox handle untouched", () => {
    const { sandbox } = buildWorld()
    expect(Object.keys(sandbox)).toEqual(["id", "provider"])
  })

  it("Agentik verticals, via the general mechanism", () => {
    const { app } = buildWorld()
    // book1/coder: open repo, pay-per-call (repo ref — unresolved here, valid ref)
    const coder = attachPricing(
      { aip: 14, id: "coder" },
      { model: "pay-per-call", unitPriceMinor: 2, currency: "usd", meter: "agent-call" },
      { billingRail: { rail: "stripe", meterId: "meter_abc", recurrence: "month" } },
    )
    // book3/SEO: private repo, prepaid pool
    const seo = attachPricing(
      { aip: 14, id: "seo-private", version: "1.2.0" },
      { model: "prepaid-pool", unitPriceMinor: 5, currency: "usd", grantUnits: 200 },
      { billingRail: { rail: "autumn", featureId: "seo-credits" } },
    )
    // default vertical: book + private app bundle, one-time
    const companion = attachPricing(refFor({ aip: 42, keyBy: (h: AppHandle) => h.id! }, app), {
      model: "one-time",
      amountMinor: 4900,
      currency: "usd",
    })
    expect(coder.price.model).toBe("pay-per-call")
    expect(companion.on).toEqual({ aip: 42, id: "book-companion" })
    expect(seo.on.version).toBe("1.2.0")
  })
})

describe("defineProduct — validation invariants", () => {
  const price = { model: "one-time", amountMinor: 1, currency: "usd" } as const

  it("freezes the handle and stamps schema product/v1", () => {
    const p = attachPricing({ aip: 42, id: "x" }, price)
    expect(p.schema).toBe("product/v1")
    expect(Object.isFrozen(p)).toBe(true)
  })

  it("rejects bad ids", () => {
    expect(() =>
      defineProduct({ id: "Bad_Id", kind: "pricing", on: { aip: 1, id: "x" }, price }),
    ).toThrow(/bad product id/)
  })

  it("rejects bad currencies", () => {
    expect(() =>
      defineProduct({
        id: "p",
        kind: "pricing",
        on: { aip: 1, id: "x" },
        price: { ...price, currency: "US" },
      }),
    ).toThrow(/ISO-4217/)
  })

  it("rejects fractional minor units", () => {
    expect(() =>
      defineProduct({
        id: "p",
        kind: "pricing",
        on: { aip: 1, id: "x" },
        price: { ...price, amountMinor: 1.5 },
      }),
    ).toThrow(/minor units/)
  })

  it("rejects grantUnits < 1 for prepaid-pool", () => {
    expect(() =>
      defineProduct({
        id: "p",
        kind: "pricing",
        on: { aip: 1, id: "x" },
        price: { model: "prepaid-pool", unitPriceMinor: 1, currency: "usd", grantUnits: 0 },
      }),
    ).toThrow(/grantUnits/)
  })
})

describe("billingRail — rail-specific rules", () => {
  const on: ArtifactRef = { aip: 42, id: "x" }

  it("Stripe pay-per-call REQUIRES meterId — the Meter is an out-of-band object", () => {
    expect(() =>
      attachPricing(on, { model: "pay-per-call", unitPriceMinor: 2, currency: "usd", meter: "m" }, {
        billingRail: { rail: "stripe", priceId: "price_1" },
      }),
    ).toThrow(/meterId/)
  })

  it("Stripe prepaid-pool is accepted (pool state is host-side — documented, not hidden)", () => {
    expect(() =>
      attachPricing(on, { model: "prepaid-pool", unitPriceMinor: 5, currency: "usd", grantUnits: 10 }, {
        billingRail: { rail: "stripe", priceId: "price_1" },
      }),
    ).not.toThrow()
  })

  it("Autumn composes natively for both metered shapes — no rail-specific hack", () => {
    expect(() =>
      attachPricing(on, { model: "pay-per-call", unitPriceMinor: 2, currency: "usd", meter: "m" }, {
        billingRail: { rail: "autumn", featureId: "agent-call" },
      }),
    ).not.toThrow()
    expect(() =>
      attachPricing(on, { model: "prepaid-pool", unitPriceMinor: 5, currency: "usd", grantUnits: 10 }, {
        billingRail: { rail: "autumn", featureId: "credits" },
      }),
    ).not.toThrow()
  })

  it("unknown rails ride along as config (open rail union)", () => {
    expect(() =>
      attachPricing(
        on,
        { model: "one-time", amountMinor: 1, currency: "usd" },
        { billingRail: { rail: "paddle", config: { apiKeyEnv: "PADDLE_KEY" } } },
      ),
    ).not.toThrow()
  })
})

describe("collectPriced — the 'collection of priced things' join", () => {
  it("joins products with resolved handles across kinds; dangling refs discoverable, never silent", () => {
    const { cat, app, pack, sandbox, tool } = buildWorld()
    const priced = [
      attachPricing(refFor({ aip: 42, keyBy: (h: AppHandle) => h.id! }, app), {
        model: "one-time",
        amountMinor: 4900,
        currency: "usd",
      }),
      attachPricing(refFor(packSpec, pack), {
        model: "prepaid-pool",
        unitPriceMinor: 5,
        currency: "usd",
        grantUnits: 200,
      }),
      attachPricing(refFor(sandboxSpec, sandbox), {
        model: "pay-per-call",
        unitPriceMinor: 1,
        currency: "usd",
        meter: "sandbox-hour",
      }),
      attachPricing(refFor(toolSpec, tool), {
        model: "pay-per-call",
        unitPriceMinor: 2,
        currency: "usd",
        meter: "tool-call",
      }),
    ]
    const joined = collectPriced(priced, ref => cat.resolve(ref))
    expect(joined).toHaveLength(4)
    expect(joined[0]!.handle).toBe(app)
    expect(joined[1]!.handle).toBe(pack)
    expect(joined[2]!.handle).toBe(sandbox)
    expect(joined[3]!.handle).toBe(tool)
    // a dangling ref: skipped by the join, but discoverable via the catalog
    expect(cat.resolve({ aip: 61, id: "ghost" })).toBeUndefined()
  })
})
