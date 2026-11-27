import { describe, expect, it } from "vitest"
import { makeBillingRegistry } from "../registry.js"
import { FakeSettlementProvider } from "../testing/index.js"
import type { SettlementProvider } from "../settlement.js"

describe("makeBillingRegistry", () => {
  it("leaves a slug outside the catalog unresolved without touching the import seam (no ctx.entry)", async () => {
    const imports: string[] = []
    const reg = makeBillingRegistry({
      importPackage: async name => {
        imports.push(name)
        throw new Error(`unexpected import of ${name}`)
      },
    })
    expect(await reg.provider("not-a-catalog-slug")).toBeNull()
    expect(imports).toEqual([])
    expect((await reg.family.list()).map(e => e.slug)).not.toContain("not-a-catalog-slug")
  })

  it("resolves a package that exports only createProvider, and passes it env and its options", async () => {
    const seen: { env?: Record<string, string | undefined>; options?: unknown }[] = []
    const env = { STRIPE_SECRET_KEY: "k", STRIPE_WEBHOOK_SECRET: "w" }
    const reg = makeBillingRegistry({
      env,
      providerOptions: { stripe: { ownerKeys: ["orgId"] } },
      importPackage: async name => {
        if (name !== "@agentproto/billing-stripe") throw new Error(`unexpected import of ${name}`)
        return {
          createProvider: (ctx: { env: Record<string, string | undefined>; options?: unknown }) => {
            seen.push({ env: ctx.env, options: ctx.options })
            return new FakeSettlementProvider("whsec-test", "stripe")
          },
        }
      },
    })
    const p = await reg.provider("stripe")
    expect(p?.id).toBe("stripe")
    expect(seen).toHaveLength(1)
    expect(seen[0]!.env).toBe(env)
    expect(seen[0]!.options).toEqual({ ownerKeys: ["orgId"] })
  })

  it("lets createProvider resolve another provider, and refuses a cycle instead of hanging", async () => {
    const reg = makeBillingRegistry({
      env: {},
      importPackage: async name => {
        if (name === "@agentproto/billing-autumn") {
          return {
            createProvider: async (ctx: { providers: (slug: string) => Promise<SettlementProvider | null> }) => {
              const stripe = await ctx.providers("stripe")
              if (!stripe) throw new Error("no stripe")
              return new FakeSettlementProvider("whsec-autumn", "autumn")
            },
          }
        }
        if (name === "@agentproto/billing-stripe") return { createProvider: () => new FakeSettlementProvider("whsec-stripe", "stripe") }
        if (name === "@agentproto/billing-lemonsqueezy") {
          return { createProvider: async (ctx: { providers: (slug: string) => Promise<SettlementProvider | null> }) => (await ctx.providers("lemonsqueezy")) ?? new FakeSettlementProvider("x", "lemonsqueezy") }
        }
        throw new Error(`unexpected import of ${name}`)
      },
    })
    expect((await reg.provider("autumn"))?.id).toBe("autumn")
    // A provider that asks for itself does not resolve, and does not hang.
    expect(await reg.provider("lemonsqueezy")).toBeNull()
  })

  it("check() of a provider whose own check fails is false, with the reason kept out of secrets", async () => {
    const failing = Object.assign(new FakeSettlementProvider("whsec-test", "fake"), {
      check: async () => ({ ok: false, reason: "key is a live key, rail is in test mode" }),
    })
    const passing = new FakeSettlementProvider("whsec-test", "fake2")
    const reg = makeBillingRegistry({ env: {}, providers: [failing, passing], importPackage: async () => ({}) })
    expect(await (await reg.family.resolve("fake"))!.check()).toBe(false)
    expect(await (await reg.family.resolve("fake2"))!.check()).toBe(true)
  })

  it("lists the capabilities of a provider", async () => {
    const reg = makeBillingRegistry({ env: {}, providers: [new FakeSettlementProvider("whsec-test", "fake")], importPackage: async () => ({}) })
    const entry = (await reg.family.list()).find(e => e.slug === "fake") as unknown as { info?: { capabilities?: { subscriptions?: boolean } } }
    expect(entry?.info?.capabilities?.subscriptions).toBe(true)
  })
})
