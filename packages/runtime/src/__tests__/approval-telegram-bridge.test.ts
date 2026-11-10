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

  describe("card text", () => {
    const FOOTER_SESSION = "Session: sess_abc"

    async function cardFor(preview: unknown): Promise<string> {
      const bridge = makeBridge()
      bridge.start()
      request(preview)
      await until(() => tg.calls.length > 0)
      bridge.stop()
      return String(tg.calls[0]!.body.text)
    }

    it("renders a summary, sections and links as plain text, not as a JSON blob", async () => {
      const letter = `Dear team, ${"I would love to join. ".repeat(450)}`
      const text = await cardFor({
        summary: "Application to Acme for the staff engineer role",
        sections: [
          { title: "Cover letter", text: letter },
          { title: "What will be sent", text: "CV and cover letter to jobs@acme.test" },
        ],
        links: [{ label: "Offer", url: "https://acme.test/jobs/42" }],
      })
      expect(text).toContain("Application to Acme for the staff engineer role")
      expect(text).toContain("Cover letter\nDear team,")
      expect(text).toContain("What will be sent\nCV and cover letter to jobs@acme.test")
      expect(text).toContain("Offer: https://acme.test/jobs/42")
      expect(text).toContain("... (truncated)")
      expect(text).not.toContain('{"title"')
      expect(text).not.toContain("sections:")
      expect(text.length).toBeLessThanOrEqual(3800)
      expect(text).toContain(FOOTER_SESSION)
      expect(text).toContain("Expires:")
      expect(text.startsWith("Approval needed: linkedin · linkedin_react\nKind: bureau.recipe-write\n\nApplication to Acme")).toBe(true)
    })

    it("does not let a long section push a short later one out of the card", async () => {
      const text = await cardFor({
        sections: [
          { title: "First", text: "a".repeat(9000) },
          { title: "Second", text: "b".repeat(9000) },
          { title: "Third", text: "short third" },
        ],
      })
      expect(text).toContain("Third\nshort third")
      expect(text.match(/a+/g)!.some(run => run.length > 1000)).toBe(true)
      expect(text.match(/b+/g)!.some(run => run.length > 1000)).toBe(true)
      expect(text.length).toBeLessThanOrEqual(3800)
      expect(text).toContain(FOOTER_SESSION)
    })

    it("clips the summary to 600 characters and the extra keys to 300", async () => {
      const text = await cardFor({ summary: "s".repeat(1000), note: "n".repeat(1000) })
      expect(text).toContain(`${"s".repeat(600)}... (truncated)`)
      expect(text).not.toContain("s".repeat(601))
      expect(text).toContain(`note: ${"n".repeat(300)}... (truncated)`)
      expect(text).not.toContain("n".repeat(301))
    })

    it("only prints a link whose url is https", async () => {
      const text = await cardFor({
        summary: "links",
        links: [
          { label: "Script", url: "javascript:alert(1)" },
          { label: "Plain", url: "http://acme.test/x" },
          { label: "Not a url", url: "nope" },
          { label: "Safe", url: "https://acme.test/safe" },
        ],
      })
      expect(text).toContain("Safe: https://acme.test/safe")
      expect(text).not.toContain("javascript:")
      expect(text).not.toContain("http://acme.test")
      expect(text).not.toContain("Not a url")
    })

    it("caps sections and links at 20 and skips entries that are not well formed", async () => {
      const sections = [
        ...Array.from({ length: 25 }, (_, i) => ({ title: `Sec${i}`, text: `text${i}` })),
      ]
      sections.splice(1, 0, { title: "NoText" } as never, { text: "NoTitle" } as never, "junk" as never)
      const links = Array.from({ length: 25 }, (_, i) => ({ label: `L${i}`, url: `https://acme.test/${i}` }))
      const text = await cardFor({ sections, links })
      expect(text).toContain("Sec19\ntext19")
      expect(text).not.toContain("Sec20")
      expect(text).not.toContain("NoText")
      expect(text).not.toContain("NoTitle")
      expect(text).not.toContain("junk")
      expect(text).toContain("L19: https://acme.test/19")
      expect(text).not.toContain("L20:")
      expect(text.length).toBeLessThanOrEqual(3800)
      expect(text).toContain(FOOTER_SESSION)
    })

    it("keeps the footer when the links alone overflow the card", async () => {
      const links = Array.from({ length: 20 }, (_, i) => ({
        label: "x".repeat(120),
        url: `https://acme.test/${i}/${"p".repeat(2000)}`,
      }))
      const text = await cardFor({ summary: "many links", links })
      expect(text.length).toBeLessThanOrEqual(3800)
      expect(text).toContain(FOOTER_SESSION)
      expect(text).toContain("Expires:")
    })

    it("does not repeat a string value that is already inside the summary or a section", async () => {
      const text = await cardFor({
        summary: "Write recipe linkedin v1.0.1",
        sections: [{ title: "What will change", text: "React to post 42" }],
        recipe: "linkedin",
        preview: "React to post 42",
        version: "1.0.1",
        tool: "linkedin_react",
      })
      expect(text.match(/React to post 42/g)).toHaveLength(1)
      expect(text).not.toContain("preview:")
      expect(text).not.toContain("recipe:")
      expect(text).not.toContain("version:")
      expect(text).toContain("tool: linkedin_react")
    })

    it("renders a preview without the convention keys exactly as before", async () => {
      const text = await cardFor({
        recipe: "linkedin",
        version: "1.0.1",
        tool: "linkedin_react",
        preview: "React to post 42",
        counts: { likes: 3 },
        skipped: null,
      })
      const expires = engine.list({ status: "pending" })[0]!.expiresAt
      expect(text).toBe(
        [
          "Approval needed: linkedin · linkedin_react",
          "Kind: bureau.recipe-write",
          "recipe: linkedin",
          "version: 1.0.1",
          "tool: linkedin_react",
          "preview: React to post 42",
          'counts: {"likes":3}',
          "",
          FOOTER_SESSION,
          `Expires: ${expires}`,
        ].join("\n"),
      )
    })

    it("treats a non-string summary as an ordinary key when no other convention key is present", async () => {
      const text = await cardFor({ summary: { a: 1 }, tool: "t" })
      expect(text).toContain('summary: {"a":1}')
    })
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
