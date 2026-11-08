/**
 * Telegram cards for the approvals engine: a pending approval that lists the
 * `telegram` channel becomes one message with Approve / Refuse buttons; a tap
 * from an allowed user in the configured chat decides it in-process; any other
 * tap is refused; a decision made elsewhere strips the buttons.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

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

  const request = (preview: unknown = { recipe: "linkedin", version: "1.0.1", tool: "linkedin_react", preview: "React to post 42" }) =>
    engine.request(
      {
        kind: "bureau.recipe-write",
        title: "linkedin · linkedin_react",
        preview,
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

  it("shows a 1500-character comment in full, within Telegram's 4096-character limit", async () => {
    const bridge = makeBridge()
    bridge.start()
    const comment = `${"Bonjour ".repeat(187)}Fin.`
    expect(comment.length).toBeGreaterThan(1500 - 10)
    request({ tool: "linkedin_react", comment })
    await until(() => tg.calls.length > 0)
    const text = String(tg.calls[0]!.body.text)
    expect(text).toContain(comment)
    expect(text).not.toContain("(truncated)")
    expect(text.length).toBeLessThanOrEqual(4096)
    bridge.stop()
  })

  it("truncates a 6000-character comment under 4096 characters and keeps Session and Expires", async () => {
    const bridge = makeBridge()
    bridge.start()
    const record = request({ tool: "linkedin_react", comment: "x".repeat(6000) })
    await until(() => tg.calls.length > 0)
    const text = String(tg.calls[0]!.body.text)
    expect(text).toContain("(truncated)")
    expect(text.length).toBeLessThanOrEqual(4096)
    expect(text).toContain("Session: sess_abc")
    expect(text).toContain(`Expires: ${record.expiresAt}`)

    const { ticket } = engine.mintCardTicket(record.id)
    await engine.decideByCard(record.id, "deny", ticket, evidence)
    await until(() => tg.calls.some(c => c.method === "editMessageText"))
    const closed = String(tg.calls.find(c => c.method === "editMessageText")!.body.text)
    expect(closed).toContain("Denied via ui_card")
    expect(closed.length).toBeLessThanOrEqual(4096)
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

  describe("restart", () => {
    const cardFile = (id: string) => join(home, id, "telegram-card.json")
    const restart = () => {
      engine.dispose()
      bus = createSessionEventBus()
      events = []
      bus.onAny(e => events.push(e))
      engine = createApprovalsEngine({ homeDir: home, sessionEvents: bus, telegramCards: true })
    }
    const edits = () => tg.calls.filter(c => c.method === "editMessageText")

    it("a tap on a card sent before the restart still decides through the telegram channel", async () => {
      const first = makeBridge()
      first.start()
      const record = request()
      await until(() => tg.calls.length > 0)
      const approve = buttons(tg.calls[0]!)[0]!
      first.stop()
      expect(existsSync(cardFile(record.id))).toBe(true)

      restart()
      const second = makeBridge()
      second.start()
      expect(await second.handleUpdate(tap(approve.callback_data))).toEqual({ handled: true })

      const decided = engine.get(record.id)!
      expect(decided.status).toBe("approved")
      expect(decided.decision?.channel).toBe("telegram")
      await until(() => edits().length === 1)
      expect(String(edits()[0]!.body.text)).toContain("Approved via telegram")
      expect(existsSync(cardFile(record.id))).toBe(false)
      second.stop()
    })

    it("keeps no bot token, chat id or user id in the card file", async () => {
      const bridge = makeBridge()
      bridge.start()
      const record = request()
      await until(() => tg.calls.length > 0)
      const raw = readFileSync(cardFile(record.id), "utf8")
      expect(raw).not.toContain("TOKEN")
      expect(raw).not.toContain(CHAT)
      expect(raw).not.toContain(JEREMY)
      expect(raw).not.toContain("chat_id")
      bridge.stop()
    })

    it("closes the message once at start when the approval was decided while the bridge was down", async () => {
      const first = makeBridge()
      first.start()
      const record = request()
      await until(() => tg.calls.length > 0)
      first.stop()

      restart()
      const { ticket } = engine.mintCardTicket(record.id)
      await engine.decideByCard(record.id, "deny", ticket, evidence)
      expect(edits()).toHaveLength(0)

      const second = makeBridge()
      second.start()
      await until(() => edits().length === 1)
      const edit = edits()[0]!
      expect(String(edit.body.text)).toContain("Denied via ui_card")
      expect((edit.body.reply_markup as { inline_keyboard: Keyboard }).inline_keyboard).toEqual([])
      await until(() => !existsSync(cardFile(record.id)))
      second.stop()

      // Another start finds no card left, so nothing is edited twice.
      const third = makeBridge()
      third.start()
      await new Promise(r => setTimeout(r, 40))
      expect(edits()).toHaveLength(1)
      third.stop()
    })

    it("removes the card file when another channel decides while the bridge runs", async () => {
      const bridge = makeBridge()
      bridge.start()
      const record = request()
      await until(() => tg.calls.length > 0)
      expect(existsSync(cardFile(record.id))).toBe(true)
      const { ticket } = engine.mintCardTicket(record.id)
      await engine.decideByCard(record.id, "approve", ticket, evidence)
      await until(() => !existsSync(cardFile(record.id)))
      bridge.stop()
    })
  })

  it("reports a failed sendMessage through onError", async () => {
    const errors: unknown[] = []
    const failing = (async () =>
      new Response(JSON.stringify({ ok: false, description: "chat not found" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
    const bridge = makeBridge({ fetchImpl: failing, onError: err => errors.push(err) })
    bridge.start()
    request()
    await until(() => errors.length > 0)
    expect(String((errors[0] as Error).message)).toContain("sendMessage")
    expect(String((errors[0] as Error).message)).not.toContain("TOKEN")
    bridge.stop()
  })

  it("is wired to the daemon log in index.ts with the [approval-telegram-bridge] prefix", () => {
    const source = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8")
    const start = source.indexOf("createApprovalTelegramBridge({")
    expect(start).toBeGreaterThan(-1)
    const call = source.slice(start, source.indexOf("approvalTelegram?.start()", start))
    expect(call).toMatch(/onError:/)
    expect(call).toContain("[approval-telegram-bridge]")
  })

  it("requires at least one allowed user id", () => {
    expect(() => makeBridge({ allowedUserIds: [] })).toThrow(/allowedUserIds/)
  })
})
