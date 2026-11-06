/**
 * Telegram cards for the approvals engine: a pending approval that lists the
 * `telegram` channel becomes one message with Approve / Refuse buttons; a tap
 * from an allowed user in the configured chat decides it in-process; any other
 * tap is refused; a decision made elsewhere strips the buttons.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionEventBus, type SessionEvent, type SessionEventBus } from "../session-event-bus.js"
import { createApprovalsEngine, type ApprovalsEngine } from "../approvals/engine.js"
import { createApprovalTelegramBridge } from "../approvals/telegram-bridge.js"

const CHAT = "4242"
const JEREMY = "1001"
const evidence = { ipAddress: "test", userAgent: "test" }

interface TgCall {
  method: string
  body: Record<string, unknown>
}

function fakeTelegram(): { fetchImpl: typeof fetch; calls: TgCall[] } {
  const calls: TgCall[] = []
  let nextMessageId = 700
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").pop()!
    calls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> })
    return new Response(JSON.stringify({ ok: true, result: { message_id: nextMessageId++ } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
  return { fetchImpl, calls }
}

const creds = { read: async () => ({ token: "TOKEN" }), write: async () => {}, exists: async () => true }

type Keyboard = Array<Array<{ text: string; callback_data: string }>>

function buttons(call: TgCall): Array<{ text: string; callback_data: string }> {
  return (call.body.reply_markup as { inline_keyboard: Keyboard }).inline_keyboard.flat()
}

function tap(data: string, opts: { userId?: string; chatId?: string } = {}) {
  return {
    update_id: 9,
    callback_query: {
      id: "cb-1",
      from: { id: Number(opts.userId ?? JEREMY) },
      message: { message_id: 700, chat: { id: Number(opts.chatId ?? CHAT) } },
      data,
    },
  }
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error("condition never became true")
}

describe("createApprovalTelegramBridge", () => {
  let home: string
  let bus: SessionEventBus
  let events: SessionEvent[]
  let engine: ApprovalsEngine
  let tg: ReturnType<typeof fakeTelegram>

  const makeBridge = (over: Partial<Parameters<typeof createApprovalTelegramBridge>[0]> = {}) =>
    createApprovalTelegramBridge({
      events: bus,
      engine,
      telegramCreds: creds,
      alias: "default",
      chatId: CHAT,
      allowedUserIds: [JEREMY],
      fetchImpl: tg.fetchImpl,
      ...over,
    })

  const request = () =>
    engine.request(
      {
        kind: "bureau.recipe-write",
        title: "linkedin · linkedin_react",
        preview: { recipe: "linkedin", version: "1.0.1", tool: "linkedin_react", preview: "React to post 42" },
        payload: { requestId: "req_1" },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      { sessionId: "sess_abc" },
    )

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "approval-tg-"))
    bus = createSessionEventBus()
    events = []
    bus.onAny(e => events.push(e))
    engine = createApprovalsEngine({ homeDir: home, sessionEvents: bus, telegramCards: true })
    tg = fakeTelegram()
  })
  afterEach(() => {
    engine.dispose()
    rmSync(home, { recursive: true, force: true })
  })

  it("sends one message with Approve / Refuse buttons whose callback data is not the approval id", async () => {
    const bridge = makeBridge()
    bridge.start()
    const record = request()
    await until(() => tg.calls.length > 0)

    expect(tg.calls).toHaveLength(1)
    const send = tg.calls[0]!
    expect(send.method).toBe("sendMessage")
    expect(send.body.chat_id).toBe(CHAT)
    const text = String(send.body.text)
    expect(text).toContain("linkedin · linkedin_react")
    expect(text).toContain("React to post 42")
    expect(text).toContain("1.0.1")
    expect(text).toContain("sess_abc")
    expect(text).toContain("Expires:")
    const keys = buttons(send)
    expect(keys.map(b => b.text)).toEqual(["Approve", "Refuse"])
    for (const b of keys) {
      expect(b.callback_data).not.toContain(record.id)
      expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64)
    }
    bridge.stop()
  })

  it("decides through the telegram channel on a tap from the allowed user, then edits the message", async () => {
    const bridge = makeBridge()
    bridge.start()
    const record = request()
    await until(() => tg.calls.length > 0)
    const approve = buttons(tg.calls[0]!)[0]!

    const res = await bridge.handleUpdate(tap(approve.callback_data))
    expect(res).toEqual({ handled: true })

    const decided = engine.get(record.id)!
    expect(decided.status).toBe("approved")
    expect(decided.decision?.channel).toBe("telegram")
    expect(events).toContainEqual(expect.objectContaining({ type: "approval:decided", channel: "telegram" }))
    await until(() => tg.calls.some(c => c.method === "editMessageText"))
    const edit = tg.calls.find(c => c.method === "editMessageText")!
    expect(String(edit.body.text)).toContain("Approved via telegram")
    expect((edit.body.reply_markup as { inline_keyboard: Keyboard }).inline_keyboard).toEqual([])
    bridge.stop()
  })

  it("a Refuse tap denies the approval", async () => {
    const bridge = makeBridge()
    bridge.start()
    const record = request()
    await until(() => tg.calls.length > 0)
    await bridge.handleUpdate(tap(buttons(tg.calls[0]!)[1]!.callback_data))
    expect(engine.get(record.id)!.status).toBe("denied")
    bridge.stop()
  })

  it("refuses a tap from another user or another chat and leaves the approval pending", async () => {
    const bridge = makeBridge()
    bridge.start()
    const record = request()
    await until(() => tg.calls.length > 0)
    const data = buttons(tg.calls[0]!)[0]!.callback_data

    expect(await bridge.handleUpdate(tap(data, { userId: "9999" }))).toEqual({ handled: true })
    expect(await bridge.handleUpdate(tap(data, { chatId: "1" }))).toEqual({ handled: true })
    expect(engine.get(record.id)!.status).toBe("pending")
    expect(tg.calls.filter(c => c.method === "answerCallbackQuery")).toHaveLength(2)
    expect(tg.calls.some(c => c.method === "editMessageText")).toBe(false)

    // The real user can still decide afterwards.
    await bridge.handleUpdate(tap(data))
    expect(engine.get(record.id)!.status).toBe("approved")
    bridge.stop()
  })

  it("strips the buttons when another channel decides, and a later tap does nothing", async () => {
    const bridge = makeBridge()
    bridge.start()
    const record = request()
    await until(() => tg.calls.length > 0)
    const data = buttons(tg.calls[0]!)[0]!.callback_data

    const { ticket } = engine.mintCardTicket(record.id)
    await engine.decideByCard(record.id, "deny", ticket, evidence)
    await until(() => tg.calls.some(c => c.method === "editMessageText"))
    const edit = tg.calls.find(c => c.method === "editMessageText")!
    expect(String(edit.body.text)).toContain("Denied via ui_card")
    expect((edit.body.reply_markup as { inline_keyboard: Keyboard }).inline_keyboard).toEqual([])

    const before = tg.calls.length
    expect(await bridge.handleUpdate(tap(data))).toEqual({ handled: true })
    expect(engine.get(record.id)!.decision?.channel).toBe("ui_card")
    expect(engine.get(record.id)!.status).toBe("denied")
    expect(tg.calls.slice(before).map(c => c.method)).toEqual(["answerCallbackQuery"])
    bridge.stop()
  })

  it("sends nothing when the approval does not list the telegram channel", async () => {
    engine = createApprovalsEngine({ homeDir: home, sessionEvents: bus })
    const bridge = makeBridge({ engine })
    bridge.start()
    const record = request()
    expect(record.channels).not.toContain("telegram")
    await new Promise(r => setTimeout(r, 40))
    expect(tg.calls).toHaveLength(0)
    bridge.stop()
  })

  it("ignores updates that are not approval taps", async () => {
    const bridge = makeBridge()
    expect(await bridge.handleUpdate(tap("perm:abc:a"))).toEqual({ handled: false })
    expect(await bridge.handleUpdate({ message: { text: "hi" } })).toEqual({ handled: false })
  })

  it("requires at least one allowed user id", () => {
    expect(() => makeBridge({ allowedUserIds: [] })).toThrow(/allowedUserIds/)
  })
})
