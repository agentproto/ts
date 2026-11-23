import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import Ajv2020 from "ajv/dist/2020.js"
import matter from "gray-matter"
import { describe, expect, it } from "vitest"
import { loadBillingManifest, parseBillingManifest } from "../manifest/index.js"
import { billingFrontmatterSchema } from "../schema.js"

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const read = (p: string) => readFileSync(here(p), "utf8")

/** The vendor strategies the four product files name: the host registers them. */
const STRATEGIES = ["x-acme:org-kind", "x-acme:welcome-by-country", "x-acme:welcome-grant"]

const FILES = ["demo", "acme", "shopbot", "usage-saas"] as const

describe("the four product files of the AIP-74 draft (fixtures, see __fixtures__/SOURCE.md)", () => {
  for (const name of FILES) {
    it(`${name}: parses and derives`, () => {
      const m = loadBillingManifest(read(`../__fixtures__/examples/${name}.BILLING.md`), { strategies: STRATEGIES })
      expect(m.name).toBe(name)
      expect(m.derived.conversions.size).toBeGreaterThan(0)
    })
    it(`${name}: is refused when a vendor strategy is not registered`, () => {
      const src = read(`../__fixtures__/examples/${name}.BILLING.md`)
      if (!/x-acme:/.test(src)) return
      expect(() => loadBillingManifest(src, { strategies: [] })).toThrow(/x-acme:/)
    })
  }

  it("derives the rates of the anchor decision: EUR at 118 per euro, USD at 100, Usage SaaS at 1 000 per dollar", () => {
    const rate = (name: string, id: string) => loadBillingManifest(read(`../__fixtures__/examples/${name}.BILLING.md`), { strategies: STRATEGIES }).derived.conversions.get(id)!.ratio
    expect(rate("demo", "eur-to-credits")).toBe(118)
    expect(rate("acme", "eur-to-credits")).toBe(118)
    expect(rate("acme", "usd-to-credits")).toBe(100)
    expect(rate("shopbot", "eur-to-credits")).toBe(118)
    expect(rate("usage-saas", "usd-to-credits")).toBe(1000)
  })
})

describe("the zod schema and BILLING.schema.json give the same verdict (no silent drift)", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  ajv.addSchema(JSON.parse(readFileSync(here("../../../../specs/resources/aip-49/draft/ASSET.schema.json"), "utf8")))
  ajv.addSchema(JSON.parse(readFileSync(here("../../../../specs/resources/aip-41/draft/ROUTINE.schema.json"), "utf8")))
  const validate = ajv.compile(JSON.parse(read("../__fixtures__/BILLING.schema.json")))
  const base = (name: string) => matter(read(`../__fixtures__/examples/${name}.BILLING.md`)).data as Record<string, any>
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

  const mutations: Record<string, (d: any) => void> = {
    "unchanged": () => undefined,
    "fiat conversion writes its own rate": d => { d.conversions[0].rate = { kind: "fixed", ratio: 100 } },
    "no anchor": d => { delete d.anchor },
    "unknown top-level key": d => { d.salePeg = {} },
    "subscription without includes": d => { delete d.offers.find((o: any) => o.price.model === "subscription").includes },
    "prepaid-pool with includes": d => { d.offers.find((o: any) => o.price.model === "prepaid-pool").includes = [{ feature: "credits" }] },
    "prepaid-pool without convert": d => { delete d.offers.find((o: any) => o.price.model === "prepaid-pool").convert },
    "bonus on a non-fiat conversion": d => { d.conversions.push({ id: "p2c", from: "DEMO_POINTS", to: "DEMO_CREDITS", rate: { kind: "fixed", ratio: 1 }, mint: { partition: "DEMO_CREDITS:grant" }, bonus: d.conversions[0].bonus }) },
    "grant key without {account}": d => { d.grants[0].key = "once" },
    "four-letter currency": d => { d.fx = { EURO: 1.18 } },
    "lower-case currency (accepted, normalised later)": d => { d.fx = { eur: 1.18 } },
    "bad duration": d => { d.offers.find((o: any) => o.price.model === "subscription").subscription.grace = "7 days" },
    "unknown strategy": d => { d.payer.strategy = "magic" },
    "credits include without partition": d => { delete d.offers.find((o: any) => o.price.model === "subscription").includes[0].partition },
    "unknown model": d => { d.offers[0].price = { model: "freemium" } },
    "vendor model": d => { d.offers[0] = { id: "v", price: { model: "x-acme:metered" } } },
    "rail with a provider": d => { d.rails[0].provider = "stripe" },
    "convert on a one-time offer": d => { d.offers.push({ id: "bad", price: { model: "one-time", amountMinor: 100, currency: "USD" }, convert: "eur-to-credits" }) },
    "subscription block on a pack": d => { d.offers.find((o: any) => o.price.model === "prepaid-pool").subscription = { anchor: "payment", onUpgrade: "none" } },
    "cap of zero": d => { d.conversions[0].capMinor = { amount: 0, windowSec: 60 } },
    "tax basis other": d => { d.taxBasis = "both" },
  }
  for (const name of FILES) {
    for (const [label, mutate] of Object.entries(mutations)) {
      it(`${name}: ${label}`, () => {
        const doc = clone(base(name))
        try {
          mutate(doc)
        } catch {
          return // a mutation that does not apply to this product's file
        }
        const json = validate(doc)
        const zod = billingFrontmatterSchema.safeParse(doc).success
        expect({ zod, json }).toEqual({ zod: json, json })
      })
    }
  }

  it("the parser reads the file through the same schema", () => {
    expect(() => parseBillingManifest("---\nschema: billing/v1\nname: Bad\n---\n")).toThrow(/name/)
    expect(() => parseBillingManifest("no frontmatter")).toThrow(/frontmatter/)
  })
})
