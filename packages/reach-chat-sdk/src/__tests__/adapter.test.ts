/**
 * The `chat-sdk` adapter, WhatsApp, against a fake `fetch` that answers
 * `graph.facebook.com` and throws on any other host. Fake tokens only: no
 * request leaves the process.
 */

import { runReachConformance, type ReachChatSdkRouteEntry, type ReachMessage } from "@agentproto/reach"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { CHAT_SDK_WHATSAPP_CAPABILITIES, chatSdkEntryProblem, createChatSdkReachAdapter, renderWhatsAppText } from "../index.js"

const TOKEN = "FAKE-ACCESS-TOKEN-do-not-log"
const PHONE_NUMBER_ID = "100000000000001"
const TO = "33600000000"

const entry: ReachChatSdkRouteEntry = {
  id: "wa",
  kind: "chat-sdk",
  platform: "whatsapp",
  to: TO,
  whatsapp: { phoneNumberId: PHONE_NUMBER_ID, accessToken: TOKEN },
}

const tell: ReachMessage = {
  summary: "Build finished: 3 tests fixed",
  links: [{ label: "Open", url: "https://example.com/runs/1" }],
  intent: "tell",
  to: "owner",
  urgency: "normal",
  dedupeKey: "tell:1",
  source: { kind: "test" },
}

const ask: ReachMessage = {
  summary: "Approve the deploy?",
  intent: "ask",
  to: "owner",
  urgency: "normal",
  dedupeKey: "approval:apr_1",
  source: { kind: "test" },
  ask: { ref: "apr_1", options: ["approve", "deny"] },
}

interface Call {
  url: string
  headers: Record<string, string>
  body: unknown
}

type Answer = (call: Call) => Response | Promise<Response>

let calls: Call[]
let answer: Answer

const ok: Answer = () =>
  new Response(JSON.stringify({ messaging_product: "whatsapp", contacts: [{ wa_id: TO }], messages: [{ id: "wamid.STUB" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

beforeEach(() => {
  calls = []
  answer = ok
  for (const k of Object.keys(process.env)) if (k.startsWith("WHATSAPP_")) vi.stubEnv(k, "")
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (new URL(url).host !== "graph.facebook.com") throw new Error(`blocked network call to ${new URL(url).host}`)
    const call: Call = {
      url,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    }
    calls.push(call)
    return answer(call)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

function metaError(status: number, code: number): Answer {
  return () =>
    new Response(JSON.stringify({ error: { message: "Meta says no, secret detail", type: "OAuthException", code, fbtrace_id: "trace" } }), {
      status,
      headers: { "content-type": "application/json" },
    })
}

function expectNothingSecret(value: unknown): void {
  const text = JSON.stringify(value)
  for (const secret of [TOKEN, PHONE_NUMBER_ID, TO, "Meta says no"]) expect(text).not.toContain(secret)
}

describe("createChatSdkReachAdapter (whatsapp)", () => {
  it("declares the capabilities of a tell-only WhatsApp adapter", () => {
    const adapter = createChatSdkReachAdapter(entry)
    expect(adapter).toMatchObject({ id: "wa", kind: "chat-sdk" })
    expect(adapter.capabilities).toEqual({
      maxChars: 4096,
      actions: 0,
      files: false,
      link: true,
      defers: false,
      retracts: false,
      identity: false,
    })
    expect(adapter.capabilities).toBe(CHAT_SDK_WHATSAPP_CAPABILITIES)
  })

  it("a tell is one POST to /<phoneNumberId>/messages carrying to and the text, and is delivered", async () => {
    const adapter = createChatSdkReachAdapter(entry)
    const receipt = await adapter.send(tell)
    expect(receipt).toMatchObject({ status: "delivered", adapterId: "wa" })
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(new URL(call!.url).pathname).toMatch(new RegExp(`^/v\\d+\\.\\d+/${PHONE_NUMBER_ID}/messages$`))
    expect(call!.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(call!.body).toMatchObject({
      messaging_product: "whatsapp",
      to: TO,
      type: "text",
      text: { body: "Build finished: 3 tests fixed\nOpen: https://example.com/runs/1" },
    })
    expectNothingSecret(receipt)
  })

  it("the same dedupeKey twice is deduped, with no second request", async () => {
    const adapter = createChatSdkReachAdapter(entry)
    expect((await adapter.send(tell)).status).toBe("delivered")
    expect((await adapter.send(tell)).status).toBe("deduped")
    expect(calls).toHaveLength(1)
  })

  it("an ask is undelivered(ask-not-supported) with zero HTTP calls", async () => {
    const adapter = createChatSdkReachAdapter(entry)
    expect(await adapter.send(ask)).toMatchObject({ status: "undelivered", reason: "ask-not-supported" })
    expect(calls).toHaveLength(0)
  })

  it("Meta error 131047 (outside the 24 h window) is undelivered(outside-24h-window)", async () => {
    answer = metaError(400, 131047)
    const receipt = await createChatSdkReachAdapter(entry).send(tell)
    expect(receipt).toMatchObject({ status: "undelivered", reason: "outside-24h-window" })
    expect(calls).toHaveLength(1)
    expectNothingSecret(receipt)
  })

  it("Meta answering 500 after the request is failed(maybe-sent), and a retry is not deduped", async () => {
    answer = metaError(500, 1)
    const adapter = createChatSdkReachAdapter(entry)
    const receipt = await adapter.send(tell)
    expect(receipt).toMatchObject({ status: "failed", reason: "maybe-sent" })
    expectNothingSecret(receipt)
    answer = ok
    expect((await adapter.send(tell)).status).toBe("delivered")
  })

  it("a transport error once the post started is failed(maybe-sent)", async () => {
    answer = () => {
      throw new TypeError("socket hang up")
    }
    expect(await createChatSdkReachAdapter(entry).send(tell)).toMatchObject({ status: "failed", reason: "maybe-sent" })
  })

  it("no answer within timeoutMs is failed(timeout)", async () => {
    answer = () => new Promise<Response>(() => {})
    const receipt = await createChatSdkReachAdapter({ ...entry, timeoutMs: 20 }).send(tell)
    expect(receipt).toMatchObject({ status: "failed", reason: "timeout" })
  })

  it("defaults to a 10 s timeout", async () => {
    vi.useFakeTimers()
    answer = () => new Promise<Response>(() => {})
    const pending = createChatSdkReachAdapter(entry).send(tell)
    await vi.advanceTimersByTimeAsync(9_999)
    let settled = false
    void pending.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toMatchObject({ status: "failed", reason: "timeout" })
  })

  it("a WHATSAPP_API_URL in the environment cannot redirect the token", async () => {
    vi.stubEnv("WHATSAPP_API_URL", "https://evil.invalid")
    expect((await createChatSdkReachAdapter(entry).send(tell)).status).toBe("delivered")
    expect(new URL(calls[0]!.url).host).toBe("graph.facebook.com")
  })

  it("logs nothing: no token, phone number or Meta text reaches the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(m => vi.spyOn(console, m).mockImplementation(() => {}))
    answer = metaError(500, 1)
    await createChatSdkReachAdapter(entry).send(tell)
    answer = metaError(400, 131047)
    await createChatSdkReachAdapter(entry).send(tell)
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    }
  })

  it("refuses an unusable entry at construction, naming a fixed reason only", () => {
    expect(() => createChatSdkReachAdapter({ ...entry, whatsapp: { phoneNumberId: PHONE_NUMBER_ID, accessToken: "" } })).toThrow(
      /\(missing-access-token\)$/,
    )
  })

  it("passes runReachConformance, for an ask and for a tell", async () => {
    const adapter = createChatSdkReachAdapter(entry)
    const handler = async (req: Request) => {
      const body = (await req.json()) as { type: string; message: ReachMessage }
      const { adapterId: _a, at: _t, ...receipt } = await adapter.send(body.message)
      return new Response(JSON.stringify(receipt), { status: 200, headers: { "content-type": "application/json" } })
    }
    const secret = "whsec_" + Buffer.alloc(32, 7).toString("base64")
    const asked = await runReachConformance(handler, { secret })
    expect(asked).toMatchObject({ ok: true })
    expect(calls).toHaveLength(0)
    const told = await runReachConformance(handler, { secret, message: tell })
    expect(told.checks.map(c => c.detail)).toEqual(["delivered", "deduped"])
    expect(told.ok).toBe(true)
    expect(calls).toHaveLength(1)
  })
})

describe("chatSdkEntryProblem", () => {
  const raw = (patch: Record<string, unknown>) => ({ ...entry, ...patch }) as Record<string, unknown>

  it("accepts a whole entry and names what is missing or wrong", () => {
    expect(chatSdkEntryProblem(raw({}))).toBeUndefined()
    expect(chatSdkEntryProblem(raw({ platform: "telegram" }))).toBe("unknown-platform")
    expect(chatSdkEntryProblem(raw({ to: undefined }))).toBe("invalid-to")
    expect(chatSdkEntryProblem(raw({ to: "+33600000000" }))).toBe("invalid-to")
    expect(chatSdkEntryProblem(raw({ whatsapp: undefined }))).toBe("missing-whatsapp")
    expect(chatSdkEntryProblem(raw({ whatsapp: { accessToken: TOKEN } }))).toBe("invalid-phone-number-id")
    expect(chatSdkEntryProblem(raw({ whatsapp: { phoneNumberId: PHONE_NUMBER_ID } }))).toBe("missing-access-token")
    expect(chatSdkEntryProblem(raw({ timeoutMs: 0 }))).toBe("invalid-timeout")
  })
})

describe("renderWhatsAppText", () => {
  it("puts the summary first, each link on its own line, and caps at 4096 chars", () => {
    expect(renderWhatsAppText({ summary: "s" })).toBe("s")
    const long = renderWhatsAppText({ summary: "x".repeat(5000), links: [{ label: "l", url: "https://e.com" }] })
    expect(long).toHaveLength(4096)
    expect(long.endsWith("…")).toBe(true)
  })
})
