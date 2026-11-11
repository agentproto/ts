/**
 * Telegram cards for the approvals engine: a pending approval that lists the
 * `telegram` channel becomes one message with Approve / Refuse buttons; a tap
 * from an allowed user in the configured chat decides it in-process; any other
 * tap is refused; a decision made elsewhere strips the buttons. The card is
 * Telegram HTML, announces every cut, and the files of `preview.attachments`
 * are uploaded as documents or photos.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs"
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
  /** The JSON body, or for an upload the form fields (a file as `{ fileName, size }`). */
  body: Record<string, unknown>
}

/** `refuse` returns a Telegram error description for a call that must fail. */
function fakeTelegram(refuse?: (call: TgCall) => string | undefined): { fetchImpl: typeof fetch; calls: TgCall[] } {
  const calls: TgCall[] = []
  let nextMessageId = 700
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").pop()!
    let body: Record<string, unknown> = {}
    if (init?.body instanceof FormData) {
      for (const [key, value] of init.body.entries()) {
        body[key] = typeof value === "string" ? value : { fileName: value.name, size: value.size }
      }
    } else {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    }
    const call = { method, body }
    calls.push(call)
    const refusal = refuse?.(call)
    if (refusal) {
      return new Response(JSON.stringify({ ok: false, description: refusal }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: nextMessageId++ } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
  return { fetchImpl, calls }
}

const creds = { read: async () => ({ token: "TOKEN" }), write: async () => {}, exists: async () => true }

/** What the reader sees: the card's HTML with the tags parsed away. */
function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
}

const CUT = /\[cut here: (\d+) more characters\. Full text on the approval page \("Voir"\)\.\]/

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
    const text = plain(String(tg.calls[0]!.body.text))
    expect(text).not.toContain("(truncated)")
    expect(text).toMatch(CUT)
    expect(text.length).toBeLessThanOrEqual(4096)
    expect(text).toContain("Session: sess_abc")
    expect(text).toContain(`Expires: ${record.expiresAt}`)

    const { ticket } = engine.mintCardTicket(record.id)
    await engine.decideByCard(record.id, "deny", ticket, evidence)
    await until(() => tg.calls.some(c => c.method === "editMessageText"))
    const closed = plain(String(tg.calls.find(c => c.method === "editMessageText")!.body.text))
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

    it("renders a summary, sections and links as text, not as a JSON blob", async () => {
      const letter = `Dear team, ${"I would love to join. ".repeat(450)}`
      const html = await cardFor({
        summary: "Application to Acme for the staff engineer role",
        sections: [
          { title: "Cover letter", text: letter },
          { title: "What will be sent", text: "CV and cover letter to jobs@acme.test" },
        ],
        links: [{ label: "Offer", url: "https://acme.test/jobs/42" }],
      })
      const text = plain(html)
      expect(text).toContain("Application to Acme for the staff engineer role")
      expect(text).toContain("Cover letter\nDear team,")
      expect(text).toContain("What will be sent\nCV and cover letter to jobs@acme.test")
      expect(html).toContain('<a href="https://acme.test/jobs/42">Offer</a>')
      expect(text).toMatch(CUT)
      expect(text).not.toContain('{"title"')
      expect(text).not.toContain("sections:")
      expect(text.length).toBeLessThanOrEqual(3800)
      expect(text).toContain(FOOTER_SESSION)
      expect(text).toContain("Expires:")
      expect(text.startsWith("Approval needed: linkedin · linkedin_react\nKind: bureau.recipe-write\n\nApplication to Acme")).toBe(true)
    })

    it("does not let a long section push a short later one out of the card", async () => {
      const text = plain(
        await cardFor({
        sections: [
          { title: "First", text: "a".repeat(9000) },
          { title: "Second", text: "b".repeat(9000) },
          { title: "Third", text: "short third" },
        ],
        }),
      )
      expect(text).toContain("Third\nshort third")
      expect(text.match(/a+/g)!.some(run => run.length > 200)).toBe(true)
      expect(text.match(/b+/g)!.some(run => run.length > 200)).toBe(true)
      expect(text.length).toBeLessThanOrEqual(1800)
      expect(text).toContain(FOOTER_SESSION)
    })

    it("clips the summary to 600 characters and leaves a long extra string off", async () => {
      const text = plain(await cardFor({ summary: "s".repeat(1000), note: "n".repeat(1000) }))
      expect(text).toContain(`${"s".repeat(600)}\n[cut here: 400 more characters.`)
      expect(text).not.toContain("s".repeat(601))
      expect(text).not.toContain("note:")
      expect(text).toContain('+1 more details on the approval page ("Voir").')
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
      expect(text).toContain('<a href="https://acme.test/safe">Safe</a>')
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
      const html = await cardFor({ sections, links })
      const text = plain(html)
      expect(text).toContain("Sec4\ntext4")
      expect(text).not.toContain("Sec5")
      expect(text).not.toContain("NoText")
      expect(text).not.toContain("NoTitle")
      expect(text).not.toContain("junk")
      expect(html).toContain('<a href="https://acme.test/19">L19</a>')
      expect(text).not.toContain("L20")
      // What is left off the card is counted, not dropped.
      expect(text).toContain('20 more sections on the approval page ("Voir").')
      expect(text).toContain('5 more links on the approval page ("Voir").')
      expect(text.length).toBeLessThanOrEqual(1800)
      expect(text).toContain(FOOTER_SESSION)
    })

    it("keeps the footer when the links alone overflow the card", async () => {
      const links = Array.from({ length: 20 }, (_, i) => ({
        label: "x".repeat(120),
        url: `https://acme.test/${i}/${"p".repeat(2000)}`,
      }))
      const text = plain(await cardFor({ summary: "many links", links }))
      expect(text).toContain('20 more links on the approval page ("Voir").')
      expect(text.length).toBeLessThanOrEqual(3800)
      expect(text).toContain(FOOTER_SESSION)
      expect(text).toContain("Expires:")
    })

    it("does not repeat a long string value that is already inside the summary or a section", async () => {
      const text = plain(
        await cardFor({
          summary: "Write recipe linkedin v1.0.1",
          sections: [{ title: "What will change", text: "React to the LinkedIn post 42 of Acme" }],
          recipe: "linkedin",
          preview: "React to the LinkedIn post 42 of Acme",
          version: "1.0.1",
          tool: "linkedin_react",
        }),
      )
      expect(text.match(/React to the LinkedIn post 42 of Acme/g)).toHaveLength(1)
      expect(text).not.toContain("preview:")
      expect(text).toContain("recipe: linkedin")
      expect(text).toContain("version: 1.0.1")
      expect(text).toContain("tool: linkedin_react")
    })

    it("still renders a short value that happens to occur inside the summary", async () => {
      const text = plain(await cardFor({ summary: "Send 15 invoices and submit them", amount: "5", action: "submit" }))
      expect(text).toContain("amount: 5")
      expect(text).toContain("action: submit")
    })

    it("still dedupes a value of 20 characters or more contained in a section", async () => {
      const long = "Reply to the thread about the Q3 budget"
      const text = plain(
        await cardFor({
          sections: [{ title: "What will change", text: `${long} with the draft below` }],
          preview: long,
          tool: "mail_reply",
        }),
      )
      expect(text.match(new RegExp(long, "g"))).toHaveLength(1)
      expect(text).not.toContain("preview:")
      expect(text).toContain("tool: mail_reply")
    })

    it("renders a preview without the convention keys as one bold key per line", async () => {
      const html = await cardFor({
        recipe: "linkedin",
        version: "1.0.1",
        tool: "linkedin_react",
        preview: "React to post 42",
        counts: { likes: 3 },
        skipped: null,
      })
      const expires = engine.list({ status: "pending" })[0]!.expiresAt
      expect(html).toBe(
        [
          "<b>Approval needed: linkedin · linkedin_react</b>",
          "Kind: bureau.recipe-write",
          "<b>recipe</b>: linkedin",
          "<b>version</b>: 1.0.1",
          "<b>tool</b>: linkedin_react",
          "<b>preview</b>: React to post 42",
          '<b>counts</b>: {"likes":3}',
          "",
          FOOTER_SESSION,
          `Expires: ${expires}`,
        ].join("\n"),
      )
      expect(plain(html)).toBe(
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
      const text = plain(await cardFor({ summary: { a: 1 }, tool: "t" }))
      expect(text).toContain('summary: {"a":1}')
    })
  })

  describe("readable card", () => {
    it("sends Telegram HTML: the approval's text is escaped and its Markdown is rendered, never shown raw", async () => {
      const bridge = makeBridge()
      bridge.start()
      request({
        summary: "Send <b>now</b> & wait",
        sections: [
          {
            title: "Cover <letter>",
            text: "# Letter\n\n**Merci** pour `cv.pdf`, voir [l'offre](https://acme.test/o?a=1&b=2)\n\n| Field | Value |\n|---|---|\n| Name | Jeremy |\n\n```\nraw <code>\n```",
          },
        ],
      })
      await until(() => tg.calls.length > 0)
      const send = tg.calls[0]!
      expect(send.body.parse_mode).toBe("HTML")
      const html = String(send.body.text)
      expect(html).toContain("Send &lt;b&gt;now&lt;/b&gt; &amp; wait")
      expect(html).toContain("<b>Cover &lt;letter&gt;</b>")
      expect(html).toContain("<b>Letter</b>")
      expect(html).toContain("<b>Merci</b> pour <code>cv.pdf</code>")
      expect(html).toContain('<a href="https://acme.test/o?a=1&amp;b=2">l\'offre</a>')
      expect(html).toContain("Field | Value\nName | Jeremy")
      expect(html).toContain("<pre>raw &lt;code&gt;</pre>")
      const text = plain(html)
      expect(text).not.toMatch(/(^|\n)#|\*\*|`|\|-/)
      bridge.stop()
    })

    it("never cuts silently: a cut says how much is left out and points at the approval page", async () => {
      const bridge = makeBridge()
      bridge.start()
      const letter = "Bonjour, je souhaite rejoindre votre equipe. ".repeat(250).trim()
      request({
        summary: "Submit the filled form: Backend Engineer at Acme Labs",
        sections: [
          { title: "Form fields", text: letter },
          { title: "What will be sent", text: "cv.pdf" },
        ],
      })
      await until(() => tg.calls.length > 0)
      const text = plain(String(tg.calls[0]!.body.text))
      expect(text).not.toContain("(truncated)")
      const kept = /Form fields\n([\s\S]*?)\n\[cut here: (\d+) more characters\. Full text on the approval page \("Voir"\)\.\]/.exec(text)
      expect(kept).not.toBeNull()
      // The card holds a prefix that ends on a word, and the count is exact.
      expect(letter.startsWith(kept![1]!)).toBe(true)
      expect(kept![1]!.length).toBeLessThanOrEqual(280)
      expect(letter[kept![1]!.length]).toBe(" ")
      expect(Number(kept![2])).toBe(letter.length - kept![1]!.length)
      expect(text).toContain("What will be sent\ncv.pdf")
      expect(text.length).toBeLessThanOrEqual(1800)
      bridge.stop()
    })

    it("closes an HTML card as HTML, and a plain card written before the HTML cards as plain text", async () => {
      const bridge = makeBridge()
      bridge.start()
      const record = request({ summary: "a < b" })
      await until(() => tg.calls.length > 0)
      await bridge.handleUpdate(tap(buttons(tg.calls[0]!)[0]!.callback_data))
      await until(() => tg.calls.some(c => c.method === "editMessageText"))
      const edit = tg.calls.find(c => c.method === "editMessageText")!
      expect(edit.body.parse_mode).toBe("HTML")
      expect(String(edit.body.text)).toContain("a &lt; b")
      expect(engine.get(record.id)!.status).toBe("approved")
      bridge.stop()

      // A card persisted by an older daemon: no parseMode, raw text.
      const old = request({ summary: "old" })
      const { ticket } = engine.mintCardTicket(old.id)
      await engine.decideByCard(old.id, "deny", ticket, evidence)
      engine.putTelegramCard({ token: "feedfeedfeed", approvalId: old.id, messageId: 55, text: "a < b" })
      tg.calls.length = 0
      const second = makeBridge()
      second.start()
      await until(() => tg.calls.some(c => c.method === "editMessageText"))
      const oldEdit = tg.calls.find(c => c.method === "editMessageText")!
      expect(oldEdit.body.message_id).toBe(55)
      expect(oldEdit.body.parse_mode).toBeUndefined()
      expect(String(oldEdit.body.text)).toContain("a < b")
      second.stop()
    })

    it("falls back to plain text when Telegram refuses the HTML, instead of losing the card", async () => {
      const errors: unknown[] = []
      tg = fakeTelegram(call => (call.body.parse_mode === "HTML" ? "Bad Request: can't parse entities" : undefined))
      const bridge = makeBridge({ fetchImpl: tg.fetchImpl, onError: err => errors.push(err) })
      bridge.start()
      request({ summary: "a < b", sections: [{ title: "Note", text: "**bold**" }] })
      await until(() => tg.calls.length >= 2)
      const second = tg.calls[1]!
      expect(second.method).toBe("sendMessage")
      expect(second.body.parse_mode).toBeUndefined()
      expect(String(second.body.text)).toContain("a < b")
      expect(String(second.body.text)).toContain("Note\nbold")
      expect(buttons(second).map(b => b.text)).toEqual(["Approve", "Refuse"])
      expect(errors).toHaveLength(1)
      bridge.stop()
    })
  })

  describe("compact card", () => {
    async function cardFor(preview: unknown): Promise<string> {
      const bridge = makeBridge()
      bridge.start()
      request(preview)
      await until(() => tg.calls.length > 0)
      bridge.stop()
      return String(tg.calls[0]!.body.text)
    }

    it("keeps a card shaped like a job kit decision under 1800 characters", async () => {
      const answers = `${"Answer line about the candidate and the role. ".repeat(60)}`.slice(0, 2400)
      const html = await cardFor({
        summary: "Decide: acme/backend, round 2",
        sections: [{ title: "answers.md", text: answers }],
        dossier: "acme/backend",
        action: "decide",
        round: 2,
        status: "open",
        decision: "go",
        comment: "c".repeat(300),
      })
      const text = plain(html)
      expect(text.length).toBeLessThanOrEqual(1800)
      expect(text).toMatch(CUT)
      expect(text).toContain("dossier: acme/backend · action: decide · round: 2 · status: open · decision: go")
      expect(text).not.toContain("ccccc")
      expect(text).toContain('+1 more details on the approval page ("Voir").')
    })

    it("keeps numbers and booleans even when long strings are left off", async () => {
      const text = plain(
        await cardFor({
          summary: "Pay the invoice",
          note: "n".repeat(100),
          amount: 5,
          urgent: true,
          other: "o".repeat(100),
        }),
      )
      expect(text).toContain("amount: 5")
      expect(text).toContain("urgent: true")
      expect(text).not.toContain("nnnnn")
      expect(text).toContain('+2 more details on the approval page ("Voir").')
    })

    it("shows 5 sections at most, each clipped to 280 characters", async () => {
      const text = plain(
        await cardFor({
          sections: Array.from({ length: 7 }, (_, i) => ({ title: `S${i}`, text: `${"w ".repeat(400)}` })),
        }),
      )
      expect(text).toContain("S4")
      expect(text).not.toContain("S5")
      expect(text).toContain('2 more sections on the approval page ("Voir").')
      expect(text.length).toBeLessThanOrEqual(1800)
    })

    it("renders a preview without convention keys exactly as before", async () => {
      const html = await cardFor({ recipe: "linkedin", tool: "react", body: "b".repeat(5000), n: 3 })
      expect(html.replace(/Expires: .*$/, "Expires: X")).toMatchInlineSnapshot(`
        "<b>Approval needed: linkedin · linkedin_react</b>
        Kind: bureau.recipe-write
        <b>recipe</b>: linkedin
        <b>tool</b>: react
        <b>body</b>: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb <i>[cut here: 2000 more characters. Full text on the approval page ("Voir").]</i>
        <b>n</b>: 3

        Session: sess_abc
        Expires: X"
      `)
    })
  })

  describe("attachments", () => {
    let data: string
    let dossier: string
    // A real 1x1 PNG header is not needed: an unreadable PNG is still a photo.
    const PNG = Buffer.from("not really a png")

    beforeEach(() => {
      data = mkdtempSync(join(tmpdir(), "approval-tg-data-"))
      dossier = join(data, "acme", "backend")
      mkdirSync(dossier, { recursive: true })
      writeFileSync(join(dossier, "cv.pdf"), "%PDF-1.4 cv")
      writeFileSync(join(dossier, "submit-page-filled.png"), PNG)
      writeFileSync(join(data, "secret.txt"), "outside the dossier")
    })
    afterEach(() => {
      rmSync(data, { recursive: true, force: true })
    })

    const uploads = () => tg.calls.filter(c => c.method === "sendDocument" || c.method === "sendPhoto")
    const card = () => tg.calls.find(c => c.method === "sendMessage")!
    const preview = (attachments: unknown) => ({
      summary: "Submit the filled form: Backend Engineer at Acme",
      dossier: "acme/backend",
      attachments,
    })

    it("uploads preview.attachments as a real document and a real photo, then sends the card that lists them", async () => {
      const bridge = makeBridge({ sendAttachments: true, attachmentDir: () => dossier })
      bridge.start()
      request(preview(["cv.pdf", "submit-page-filled.png"]))
      await until(() => tg.calls.some(c => c.method === "sendMessage"))

      expect(tg.calls.map(c => c.method)).toEqual(["sendDocument", "sendPhoto", "sendMessage"])
      const [doc, photo] = uploads()
      expect(doc!.body.chat_id).toBe(CHAT)
      expect(doc!.body.document).toEqual({ fileName: "cv.pdf", size: 11 })
      expect(String(doc!.body.caption)).toContain("cv.pdf")
      expect(photo!.body.photo).toEqual({ fileName: "submit-page-filled.png", size: PNG.length })

      const text = plain(String(card().body.text))
      expect(text).toContain("Attachments\ncv.pdf (11 B), sent above\nsubmit-page-filled.png (16 B), sent above")
      expect(text).not.toContain("attachments:")
      expect(buttons(card()).map(b => b.text)).toEqual(["Approve", "Refuse"])
      bridge.stop()
    })

    it("refuses a path that leaves the folder (.., absolute, outgoing symlink) and says so on the card", async () => {
      symlinkSync(join(data, "secret.txt"), join(dossier, "link-out.txt"))
      symlinkSync(join(dossier, "cv.pdf"), join(dossier, "link-in.pdf"))
      const bridge = makeBridge({ sendAttachments: true, attachmentDir: () => dossier })
      bridge.start()
      request(preview(["../../secret.txt", join(data, "secret.txt"), "link-out.txt", "sub/../../../secret.txt", "link-in.pdf"]))
      await until(() => tg.calls.some(c => c.method === "sendMessage"))

      // Only the symlink that stays inside the folder is uploaded.
      expect(uploads().map(c => (c.body.document as { fileName: string }).fileName)).toEqual(["cv.pdf"])
      const text = plain(String(card().body.text))
      const refused = "NOT attached, refused, the path leaves the approval folder"
      expect(text).toContain(`../../secret.txt: ${refused}`)
      expect(text).toContain(`${join(data, "secret.txt")}: ${refused}`)
      expect(text).toContain(`link-out.txt: ${refused}`)
      expect(text).toContain(`sub/../../../secret.txt: ${refused}`)
      expect(text).toContain("link-in.pdf (11 B), sent above")
      expect(JSON.stringify(tg.calls)).not.toContain("outside the dossier")
      bridge.stop()
    })

    it("reports a missing, empty or oversized file on the card instead of dropping it", async () => {
      writeFileSync(join(dossier, "empty.pdf"), "")
      writeFileSync(join(dossier, "huge.zip"), "")
      truncateSync(join(dossier, "huge.zip"), 51 * 1024 * 1024)
      mkdirSync(join(dossier, "folder"))
      const bridge = makeBridge({ sendAttachments: true, attachmentDir: () => dossier })
      bridge.start()
      request(preview(["missing.pdf", "huge.zip", "empty.pdf", "folder", "cv.pdf", 42]))
      await until(() => tg.calls.some(c => c.method === "sendMessage"))

      expect(uploads()).toHaveLength(1)
      const text = plain(String(card().body.text))
      expect(text).toContain("missing.pdf: NOT attached, file not found")
      expect(text).toContain("huge.zip: NOT attached, too large (51 MB, Telegram limit 50 MB)")
      expect(text).toContain("empty.pdf: NOT attached, empty file")
      expect(text).toContain("folder: NOT attached, not a file")
      expect(text).toContain("cv.pdf (11 B), sent above")
      expect(text).toContain("(entry): NOT attached, not a file name")
      bridge.stop()
    })

    it("says so on the card when no folder is known or Telegram rejects the upload, and still sends the card", async () => {
      const noDir = makeBridge({ sendAttachments: true })
      noDir.start()
      request(preview(["cv.pdf"]))
      await until(() => tg.calls.some(c => c.method === "sendMessage"))
      expect(uploads()).toHaveLength(0)
      expect(plain(String(card().body.text))).toContain("cv.pdf: NOT attached, no folder is known for this approval")
      noDir.stop()

      const errors: unknown[] = []
      tg = fakeTelegram(call => (call.method === "sendDocument" ? "Bad Request: file must be non-empty" : undefined))
      const bridge = makeBridge({ sendAttachments: true, fetchImpl: tg.fetchImpl, attachmentDir: () => dossier, onError: e => errors.push(e) })
      bridge.start()
      request(preview(["cv.pdf", "submit-page-filled.png"]))
      await until(() => tg.calls.some(c => c.method === "sendMessage"))
      const text = plain(String(card().body.text))
      expect(text).toContain("cv.pdf: NOT attached, Telegram did not accept the file")
      expect(text).toContain("submit-page-filled.png (16 B), sent above")
      expect(errors).toHaveLength(1)
      bridge.stop()
    })

    it("sends an image Telegram refuses as a photo as a document instead", async () => {
      tg = fakeTelegram(call => (call.method === "sendPhoto" ? "Bad Request: PHOTO_INVALID_DIMENSIONS" : undefined))
      const bridge = makeBridge({ sendAttachments: true, fetchImpl: tg.fetchImpl, attachmentDir: () => dossier })
      bridge.start()
      request(preview(["submit-page-filled.png"]))
      await until(() => tg.calls.some(c => c.method === "sendMessage"))
      expect(tg.calls.map(c => c.method)).toEqual(["sendPhoto", "sendDocument", "sendMessage"])
      expect(plain(String(card().body.text))).toContain("submit-page-filled.png (16 B), sent above")
      bridge.stop()
    })

    it("leaves a card without file names in attachments unchanged: nothing is uploaded", async () => {
      const bridge = makeBridge({ sendAttachments: true, attachmentDir: () => dossier })
      bridge.start()
      request({ kind: "mail", subject: "Hello", attachments: [{ fileName: "cv.pdf", sizeBytes: 11 }] })
      await until(() => tg.calls.length > 0)
      expect(tg.calls.map(c => c.method)).toEqual(["sendMessage"])
      const text = plain(String(tg.calls[0]!.body.text))
      expect(text).toContain('attachments: [{"fileName":"cv.pdf","sizeBytes":11}]')
      expect(text).not.toContain("NOT attached")
      bridge.stop()
    })

    it("by default sends no file and the card has one Files line, never NOT attached", async () => {
      const bridge = makeBridge({ attachmentDir: () => dossier })
      bridge.start()
      request(preview(["cv.pdf", "submit-page-filled.png", "missing.pdf"]))
      await until(() => tg.calls.some(c => c.method === "sendMessage"))
      expect(tg.calls.map(c => c.method)).toEqual(["sendMessage"])
      const text = plain(String(card().body.text))
      expect(text).toContain("Files: cv.pdf, submit-page-filled.png, missing.pdf (on the approval page)")
      expect(text).not.toContain("NOT attached")
      expect(text).not.toContain("sent above")
      expect(text).not.toContain("attachments:")
      bridge.stop()
    })

    it("by default lists at most 10 names then counts the rest", async () => {
      const bridge = makeBridge({ attachmentDir: () => dossier })
      bridge.start()
      request(preview(Array.from({ length: 13 }, (_, i) => `f${i}.pdf`)))
      await until(() => tg.calls.some(c => c.method === "sendMessage"))
      const text = plain(String(card().body.text))
      expect(text).toContain("f9.pdf, +3 more (on the approval page)")
      expect(text).not.toContain("f10.pdf")
      bridge.stop()
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
