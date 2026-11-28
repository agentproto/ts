import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { createAppRegistry } from "../app-registry.js"
import { DeviceAccessStore, setDeviceAccessStoreForTests } from "../device-access.js"
import { createTelegramLinkSender, registerDeviceAccessTools, type TelegramLinkSender } from "../device-access-tools.js"

const BASE = "https://m.tunnel.example"

async function setup(over: { telegram?: TelegramLinkSender | null; confirmation?: boolean } = {}) {
  const appRegistry = createAppRegistry()
  appRegistry.upsertApp({ appId: "acme/one", dir: "/x", agents: [], workflows: [], unvalidatedAgentTools: [], ui: { path: "/x/ui.html" } })
  appRegistry.upsertApp({ appId: "acme/headless", dir: "/x", agents: [], workflows: [], unvalidatedAgentTools: [] })
  const sent: Array<{ text: string; buttonText: string; url: string }> = []
  const telegram: TelegramLinkSender | undefined =
    over.telegram === null ? undefined : (over.telegram ?? { send: async m => void sent.push(m) })
  const server = new McpServer({ name: "t", version: "0" })
  registerDeviceAccessTools(server, {
    appRegistry,
    machineName: "Studio",
    confirmationAvailable: over.confirmation ?? true,
    ...(telegram ? { telegram } : {}),
  })
  const [c, s] = InMemoryTransport.createLinkedPair()
  await server.connect(s)
  const client = new Client({ name: "t", version: "0" })
  await client.connect(c)
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> }
    return { isError: r.isError === true, text: r.content[0]!.text }
  }
  return { call, sent }
}

describe("device_offer", () => {
  let store: DeviceAccessStore
  beforeEach(() => {
    store = new DeviceAccessStore({ persist: false })
    setDeviceAccessStoreForTests(store)
  })
  afterEach(() => setDeviceAccessStoreForTests(undefined))

  it("sends the link on Telegram and answers without it, so the code never reaches the caller", async () => {
    const { call, sent } = await setup()
    const r = await call("device_offer", { apps: "*", baseUrl: BASE })
    expect(r.isError).toBe(false)
    const body = JSON.parse(r.text) as Record<string, unknown>
    expect(body).toMatchObject({ sent: true, deliver: "telegram", scope: { apps: "*", sessionsRead: false } })
    expect(r.text).not.toMatch(/pair#o=|agentapp:/)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toMatch(new RegExp(`^${BASE}/pair#o=[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$`))
    expect(sent[0]!.buttonText).toBe("Connect this device")
    expect(sent[0]!.text).not.toContain("pair#o=")
    // The offer in the link is really usable, once.
    const code = decodeURIComponent(sent[0]!.url.split("#o=")[1]!)
    expect(store.request({ offer: code }).ok).toBe(true)
    expect(store.request({ offer: code })).toEqual({ ok: false, error: "invalid_offer" })
  })

  it('returns the link only when asked (deliver: "return"), https only, with the fallback link', async () => {
    const { call } = await setup({ telegram: null })
    const r = await call("device_offer", { apps: ["acme/one"], baseUrl: BASE, sessionsRead: true })
    const body = JSON.parse(r.text) as { link: string; fallbackLink: string; scope: unknown }
    expect(body.link).toContain("/pair#o=")
    expect(body.fallbackLink).toMatch(/^agentapp:\/\/pair\?h=/)
    expect(body.scope).toEqual({ apps: ["acme/one"], sessionsRead: true })
    const http = await call("device_offer", { apps: "*", baseUrl: "http://example.com", deliver: "return" })
    expect(http.isError).toBe(true)
    expect(http.text).toMatch(/https/)
    const local = await call("device_offer", { apps: "*", baseUrl: "http://127.0.0.1:18790", deliver: "return" })
    expect(local.isError).toBe(false)
  })

  it("refuses without a confirmation channel, an unknown or UI-less app, a missing base URL, and Telegram when not set up", async () => {
    expect((await (await setup({ confirmation: false })).call("device_offer", { apps: "*", baseUrl: BASE })).text).toMatch(/no confirmation channel/)
    const { call } = await setup({ telegram: null })
    expect((await call("device_offer", { apps: ["acme/headless"], baseUrl: BASE, deliver: "return" })).text).toMatch(/acme\/headless/)
    expect((await call("device_offer", { apps: ["nope"], baseUrl: BASE, deliver: "return" })).isError).toBe(true)
    expect((await call("device_offer", { apps: "*", deliver: "return" })).text).toMatch(/baseUrl/)
    expect((await call("device_offer", { apps: "*", baseUrl: `${BASE}/sub/path`, deliver: "return" })).text).toMatch(/bare origin/)
    expect((await call("device_offer", { apps: "*", baseUrl: BASE, deliver: "telegram" })).text).toMatch(/Telegram is not set up/)
  })

  it("reports a Telegram failure instead of pretending the link was sent", async () => {
    const { call } = await setup({ telegram: { send: async () => { throw new Error("chat not found") } } })
    const r = await call("device_offer", { apps: "*", baseUrl: BASE })
    expect(r.isError).toBe(true)
    expect(r.text).toContain("chat not found")
  })

  it("exposes no tool that confirms a request or widens a device", async () => {
    const server = new McpServer({ name: "t", version: "0" })
    registerDeviceAccessTools(server, { appRegistry: createAppRegistry(), machineName: "m", confirmationAvailable: true })
    const [c, s] = InMemoryTransport.createLinkedPair()
    await server.connect(s)
    const client = new Client({ name: "t", version: "0" })
    await client.connect(c)
    expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(["device_offer", "device_pair_pending"])
  })
})

describe("device_pair_pending", () => {
  it("lists waiting requests with the number but never a secret", async () => {
    const store = new DeviceAccessStore({ persist: false })
    setDeviceAccessStoreForTests(store)
    const offer = store.offer({ grant: { apps: "*" } })
    const req = store.request({ offer: offer.code, deviceName: "Pixel", platform: "android" })
    if (!req.ok) throw new Error("request")
    const { call } = await setup()
    const r = await call("device_pair_pending")
    expect(r.text).toContain(req.number)
    expect(r.text).toContain("Pixel")
    expect(r.text).not.toContain(req.pollSecret)
    expect(r.text).not.toContain(offer.code)
    setDeviceAccessStoreForTests(undefined)
  })
})

describe("createTelegramLinkSender", () => {
  it("posts one message with a URL button and protect_content, and surfaces an API error", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const ok = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
    })
    const sender = createTelegramLinkSender({ readToken: async () => "123:ABC", chatId: "42", fetch: ok as never })
    await sender.send({ text: "hi", buttonText: "Go", url: "https://h.example/pair#o=X" })
    expect(calls[0]!.url).toBe("https://api.telegram.org/bot123:ABC/sendMessage")
    expect(calls[0]!.body).toMatchObject({
      chat_id: "42",
      protect_content: true,
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: "Go", url: "https://h.example/pair#o=X" }]] },
    })
    const bad = createTelegramLinkSender({
      readToken: async () => "123:ABC",
      chatId: "42",
      fetch: (async () => new Response(JSON.stringify({ ok: false, description: "Forbidden" }), { status: 403 })) as never,
    })
    await expect(bad.send({ text: "x", buttonText: "y", url: "https://h" })).rejects.toThrow(/Forbidden/)
    const none = createTelegramLinkSender({ readToken: async () => null, chatId: "42", fetch: ok as never })
    await expect(none.send({ text: "x", buttonText: "y", url: "https://h" })).rejects.toThrow(/no Telegram bot token/)
  })
})
