import { describe, expect, it } from "vitest"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { makeBillingRegistry } from "@agentproto/billing"
import { FakeSettlementProvider } from "@agentproto/billing/testing"
import { defineVoiceProvider, makeVoiceRegistry, VOICE_CATALOG } from "@agentproto/voice"
import { makeFakeStt, makeFakeTts } from "@agentproto/voice/testing"
import { registerVoiceBillingTools } from "../voice-billing-adapters.js"

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>

function fakeServer() {
  const tools = new Map<string, Handler>()
  const server = {
    tool: (name: string, _d: string, _s: unknown, handler: Handler) => {
      tools.set(name, handler)
    },
  } as unknown as McpServer
  return { server, tools }
}

const SECRET = "sk-test-secret-value"

describe("registerVoiceBillingTools", () => {
  it("registers the list/setup tools of both families", async () => {
    const { server, tools } = fakeServer()
    await registerVoiceBillingTools(server, {
      voiceRegistry: makeVoiceRegistry({ env: {}, importPackage: async () => ({}) }),
      billingRegistry: makeBillingRegistry({ env: {}, importPackage: async () => ({}) }),
    })
    expect([...tools.keys()].sort()).toEqual([
      "list_billing_providers",
      "list_voice_providers",
      "setup_billing_provider",
      "setup_voice_provider",
    ])
  })

  it("list_voice_providers reports the voice catalog and a configured in-process provider, without credentials", async () => {
    const { server, tools } = fakeServer()
    const acme = defineVoiceProvider({
      slug: "acme",
      name: "Acme",
      env: { apiKey: "ACME_API_KEY" },
      stt: makeFakeStt({ slug: "acme" }),
      tts: makeFakeTts({ slug: "acme" }),
    })
    await registerVoiceBillingTools(server, {
      voiceRegistry: makeVoiceRegistry({
        providers: [acme],
        env: { ACME_API_KEY: SECRET },
        importPackage: async () => ({}),
      }),
      billingRegistry: makeBillingRegistry({ env: {}, importPackage: async () => ({}) }),
    })
    const res = await tools.get("list_voice_providers")!({})
    expect(res.isError).toBeFalsy()
    const text = res.content[0]!.text
    expect(text).not.toContain(SECRET)
    const entries = JSON.parse(text) as Array<{ slug: string; status: string }>
    const slugs = entries.map(e => e.slug)
    for (const e of VOICE_CATALOG) expect(slugs).toContain(e.slug)
    expect(slugs).toContain("acme")
    expect(entries.find(e => e.slug === "acme")?.status).toBe("ready")
    // No billing slug leaks into the voice list.
    expect(slugs).not.toContain("stripe")
  })

  it("list_billing_providers reads the billing family, not the voice one", async () => {
    const { server, tools } = fakeServer()
    await registerVoiceBillingTools(server, {
      voiceRegistry: makeVoiceRegistry({ env: {}, importPackage: async () => ({}) }),
      billingRegistry: makeBillingRegistry({
        providers: [new FakeSettlementProvider("whsec", "fakerail")],
        env: { FAKERAIL_SECRET_KEY: SECRET, FAKERAIL_WEBHOOK_SECRET: SECRET },
        importPackage: async () => ({}),
      }),
    })
    const res = await tools.get("list_billing_providers")!({})
    const text = res.content[0]!.text
    expect(text).not.toContain(SECRET)
    const slugs = (JSON.parse(text) as Array<{ slug: string }>).map(e => e.slug)
    expect(slugs).toContain("fakerail")
    expect(slugs).not.toContain("elevenlabs")
  })

  it("setup_* never writes or echoes a secret (environment store is read-only)", async () => {
    const { server, tools } = fakeServer()
    await registerVoiceBillingTools(server, {
      voiceRegistry: makeVoiceRegistry({ env: {}, importPackage: async () => ({}) }),
      billingRegistry: makeBillingRegistry({
        providers: [new FakeSettlementProvider("whsec", "fakerail")],
        env: {},
        importPackage: async () => ({}),
      }),
    })
    const res = await tools.get("setup_billing_provider")!({
      slug: "fakerail",
      FAKERAIL_SECRET_KEY: SECRET,
      FAKERAIL_WEBHOOK_SECRET: SECRET,
    })
    expect(res.content[0]!.text).not.toContain(SECRET)
    expect(res.content[0]!.text).toMatch(/read-only/)
  })
})
