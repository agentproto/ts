/**
 * `planReachRoute`: the daemon builds the owner's route once and starts the
 * router only when at least one adapter can deliver. A telegram-only route on
 * a daemon without Telegram approval cards starts nothing and says why.
 */

import type { ReachMessage } from "@agentproto/reach"
import { createChatSdkReachAdapter } from "@agentproto/reach-chat-sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { loadChatSdkReachFactory, planReachRoute } from "../reach/index.js"

const SECRET = "whsec_" + Buffer.alloc(32, 3).toString("base64")
const webhook = { id: "pygmalion", kind: "webhook", url: "https://receiver.invalid/api/reach", secret: SECRET }
const floor = { id: "floor", kind: "telegram" }
const bridge = { announce: async () => ({ posted: true as const }) }

describe("planReachRoute", () => {
  it("a telegram-only route with no bridge (telegramApprovalCards off) is off, with one reach: warning", () => {
    const plan = planReachRoute([floor], { telegramBridge: () => undefined, telegramAvailable: false })
    expect(plan.on).toBe(false)
    expect(plan.unservable).toEqual([{ index: 0, id: "floor", reason: "telegram-not-configured" }])
    expect(plan.warnings).toEqual([
      "reach: routes.owner has no adapter that can deliver (floor: telegram-not-configured); router not started, approvals are announced as without reach",
    ])
  })

  it("a telegram entry for another alias cannot deliver either", () => {
    const plan = planReachRoute([{ ...floor, alias: "other" }], { telegramBridge: bridge, telegramAlias: "default" })
    expect(plan.on).toBe(false)
    expect(plan.unservable).toEqual([{ index: 0, id: "floor", reason: "alias-not-configured" }])
  })

  it("is on with a telegram entry the bridge serves, built before the bridge exists", async () => {
    let late: typeof bridge | undefined
    const plan = planReachRoute([floor], { telegramBridge: () => late, telegramAvailable: true })
    expect(plan.on).toBe(true)
    expect(plan.warnings).toEqual([])
    late = bridge
    const receipt = await plan.adapters[0]!.send({
      summary: "s",
      intent: "ask",
      to: "owner",
      urgency: "normal",
      dedupeKey: "approval:apr_1",
      source: { kind: "k" },
      ask: { ref: "apr_1", options: ["approve", "deny"] },
    })
    expect(receipt.status).toBe("delivered")
  })

  it("is on with a webhook even when the telegram floor cannot serve", () => {
    const plan = planReachRoute([webhook, floor], { telegramAvailable: false })
    expect(plan.on).toBe(true)
    expect(plan.adapters.map(a => a.id)).toEqual(["pygmalion", "floor"])
    expect(plan.warnings).toEqual([])
  })

  it("no entries: off and silent; only bad entries: off, each named, nothing secret", () => {
    expect(planReachRoute([])).toMatchObject({ on: false, warnings: [] })
    const plan = planReachRoute([{ id: "p", kind: "webhook", url: "https://r.invalid/x", secret: "plain" }])
    expect(plan.on).toBe(false)
    expect(plan.warnings).toEqual([
      "reach: route entry p skipped (invalid-secret)",
      "reach: routes.owner has no adapter that can deliver (no usable entry); router not started, approvals are announced as without reach",
    ])
    expect(plan.warnings.join(" ")).not.toContain("r.invalid")
  })
})

describe("planReachRoute: chat-sdk entries", () => {
  const TOKEN = "FAKE-ACCESS-TOKEN-do-not-log"
  const wa = {
    id: "wa",
    kind: "chat-sdk",
    platform: "whatsapp",
    to: "33600000000",
    whatsapp: { phoneNumberId: "100000000000001", accessToken: TOKEN },
  }
  const tell: ReachMessage = {
    summary: "Build finished",
    links: [{ label: "Open", url: "https://example.com/runs/1" }],
    intent: "tell",
    to: "owner",
    urgency: "normal",
    dedupeKey: "tell:1",
    source: { kind: "test" },
  }
  let calls: Array<{ url: string; body: unknown }>

  beforeEach(() => {
    calls = []
    for (const k of Object.keys(process.env)) if (k.startsWith("WHATSAPP_")) vi.stubEnv(k, "")
    vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (new URL(url).host !== "graph.facebook.com") throw new Error(`blocked network call to ${new URL(url).host}`)
      calls.push({ url, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body })
      return new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: "wamid.STUB" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it("with the factory, builds the adapter, and a tell posts one WhatsApp text", async () => {
    const plan = planReachRoute([wa, floor], { telegramBridge: bridge, chatSdkFactory: createChatSdkReachAdapter })
    expect(plan.skipped).toEqual([])
    expect(plan.adapters.map(a => [a.id, a.kind])).toEqual([
      ["wa", "chat-sdk"],
      ["floor", "telegram"],
    ])
    expect(plan.on).toBe(true)
    expect(await plan.adapters[0]!.send(tell)).toMatchObject({ status: "delivered", adapterId: "wa" })
    expect(calls).toHaveLength(1)
    expect(new URL(calls[0]!.url).pathname).toMatch(/\/100000000000001\/messages$/)
    expect(calls[0]!.body).toMatchObject({ to: "33600000000", text: { body: "Build finished\nOpen: https://example.com/runs/1" } })
  })

  it("without the factory, the entry is skipped chat-sdk-not-installed and the floor still serves", () => {
    const plan = planReachRoute([wa, floor], { telegramBridge: bridge })
    expect(plan.skipped).toEqual([{ index: 0, id: "wa", reason: "chat-sdk-not-installed" }])
    expect(plan.adapters.map(a => a.id)).toEqual(["floor"])
    expect(plan.on).toBe(true)
    expect(plan.warnings).toEqual(["reach: route entry wa skipped (chat-sdk-not-installed)"])
  })

  it("an entry without to or without accessToken is skipped with its reason, nothing secret in a warning", () => {
    const factory = vi.fn(createChatSdkReachAdapter)
    const noTo = { ...wa, id: "a", to: undefined }
    const noToken = { ...wa, id: "b", whatsapp: { phoneNumberId: "100000000000001" } }
    const plan = planReachRoute([noTo, noToken, floor], { telegramBridge: bridge, chatSdkFactory: factory })
    expect(plan.skipped).toEqual([
      { index: 0, id: "a", reason: "invalid-to" },
      { index: 1, id: "b", reason: "missing-access-token" },
    ])
    expect(factory).not.toHaveBeenCalled()
    expect(plan.warnings.join(" ")).not.toContain(TOKEN)
  })

  it("an ask through the chat-sdk adapter is undelivered(ask-not-supported) with no request", async () => {
    const plan = planReachRoute([wa, floor], { telegramBridge: bridge, chatSdkFactory: createChatSdkReachAdapter })
    const receipt = await plan.adapters[0]!.send({ ...tell, intent: "ask", dedupeKey: "approval:apr_1", ask: { ref: "apr_1", options: ["approve", "deny"] } })
    expect(receipt).toMatchObject({ status: "undelivered", reason: "ask-not-supported" })
    expect(calls).toHaveLength(0)
  })

  it("a chat-sdk-only route is off: it cannot acknowledge an approval, so the bridge keeps announcing", () => {
    const plan = planReachRoute([wa], { chatSdkFactory: createChatSdkReachAdapter })
    expect(plan.on).toBe(false)
    expect(plan.warnings).toEqual([
      "reach: routes.owner has no adapter that can deliver (wa: tell-only); router not started, approvals are announced as without reach",
    ])
  })
})

describe("loadChatSdkReachFactory", () => {
  const wa = { id: "wa", kind: "chat-sdk" }

  it("imports nothing when the route names no chat-sdk entry", async () => {
    const importer = vi.fn(async () => ({ createChatSdkReachAdapter }))
    expect(await loadChatSdkReachFactory([floor, webhook], importer)).toBeUndefined()
    expect(importer).not.toHaveBeenCalled()
  })

  it("resolves the package factory when the route names one", async () => {
    expect(await loadChatSdkReachFactory([wa, floor])).toBe(createChatSdkReachAdapter)
  })

  it("a package that fails to load resolves to undefined, not a throw", async () => {
    const importer = async () => {
      throw new Error("Cannot find package '@agentproto/reach-chat-sdk'")
    }
    expect(await loadChatSdkReachFactory([wa], importer)).toBeUndefined()
  })
})
