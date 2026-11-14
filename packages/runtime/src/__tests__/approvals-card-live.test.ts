/**
 * The card resources are templates: a host (Claude Desktop) reads a `ui://`
 * resource once per connection and reuses that HTML on every later tool call,
 * so the HTML must hold no approval data and no ticket. The page fetches its
 * cards through the app-only `approval_card_list` and refreshes them on a
 * `ui/notifications/tool-result`, after a decision and every 30 s.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { APPROVAL_PENDING_RESOURCE_URI, approvalCardResourceUri } from "../approvals/card.js"
import { createApprovalsEngine, type ApprovalsEngine } from "../approvals/engine.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { connectCards, readCardHtml, runCardPage } from "./helpers/approvals-card-page.js"

let home: string
let engine: ApprovalsEngine
let closeCards: (() => Promise<void>) | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "approvals-card-live-"))
  engine = createApprovalsEngine({ homeDir: home, sessionEvents: createSessionEventBus() })
})

afterEach(async () => {
  vi.useRealTimers()
  await closeCards?.()
  closeCards = undefined
  engine.dispose()
  rmSync(home, { recursive: true, force: true })
})

function request(title: string, extra: { expiresAt?: string } = {}): string {
  return engine.request(
    { kind: "send", title, preview: { to: "ana@example.com" }, payload: { title }, ...extra },
    { sessionId: "sess_abc" },
  ).id
}

async function cardsHost() {
  const host = await connectCards(engine)
  closeCards = host.close
  return host
}

describe("the card resources are templates", () => {
  it("reading either resource gives HTML with no ticket and no approval data", async () => {
    const title = "Wire 4200 EUR to Zorglub Holdings"
    const id = request(title)
    const { client } = await cardsHost()

    for (const uri of [APPROVAL_PENDING_RESOURCE_URI, approvalCardResourceUri(id)]) {
      const html = await readCardHtml(client, uri)
      expect(html).not.toContain(title)
      expect(html).not.toContain("Zorglub")
      expect(html).not.toContain("ana@example.com")
      expect(html).not.toContain("var TICKET")
      expect(html).not.toMatch(/ticket"?\s*[:=]\s*"/i)
    }
  })

  it("a read mints nothing: the ticket an earlier list handed out still decides", async () => {
    const id = request("Send")
    const { client, callTool } = await cardsHost()
    const listed = (await callTool("approval_card_list", {})) as {
      structuredContent: { approvals: Array<{ id: string; ticket: string }> }
    }
    const ticket = listed.structuredContent.approvals[0]!.ticket

    await readCardHtml(client, APPROVAL_PENDING_RESOURCE_URI)
    await readCardHtml(client, approvalCardResourceUri(id))

    const decided = (await callTool("approval_card_decide", { approvalId: id, decision: "approve", ticket })) as {
      isError?: boolean
    }
    expect(decided.isError).toBeFalsy()
    expect(engine.get(id)?.status).toBe("approved")
  })

  it("the two pages differ only by the approval id they target", async () => {
    const id = request("Send")
    const { client } = await cardsHost()
    const pending = await readCardHtml(client, APPROVAL_PENDING_RESOURCE_URI)
    const single = await readCardHtml(client, approvalCardResourceUri(id))
    expect(single.replaceAll(JSON.stringify(id), "null")).toBe(pending)
  })

  it("the same HTML, read before and after another approval exists, is byte-identical", async () => {
    const { client } = await cardsHost()
    const before = await readCardHtml(client, APPROVAL_PENDING_RESOURCE_URI)
    request("Created later")
    expect(await readCardHtml(client, APPROVAL_PENDING_RESOURCE_URI)).toBe(before)
  })
})

describe("a cached page shows approvals created after it was read", () => {
  it("shows a new approval once a ui/notifications/tool-result arrives", async () => {
    request("First")
    const { client, callTool } = await cardsHost()
    const cachedHtml = await readCardHtml(client, APPROVAL_PENDING_RESOURCE_URI)

    const page = runCardPage(cachedHtml, { callTool })
    await page.flush()
    expect(page.cards().map(c => page.titleOf(c))).toEqual(["First"])

    request("Created after the card was shown")
    await page.flush()
    expect(page.cards().map(c => page.titleOf(c))).toEqual(["First"])

    page.notify("ui/notifications/tool-result", { content: [] })
    await page.flush()
    expect(page.cards().map(c => page.titleOf(c))).toEqual(["First", "Created after the card was shown"])
    for (const card of page.cards()) expect(page.buttons(card).approve.disabled).toBe(false)
  })

  it("settles through a slow host: the whole handshake, list, decide, refresh chain completes", async () => {
    const id = request("Slow host")
    const { client, callTool } = await cardsHost()
    const slow = async (name: string, args: Record<string, unknown>) => {
      await new Promise(resolve => setTimeout(resolve, 150))
      return callTool(name, args)
    }
    const page = runCardPage(await readCardHtml(client, approvalCardResourceUri(id)), { callTool: slow })
    await page.flush()
    expect(page.cards()).toHaveLength(1)

    page.buttons(page.cards()[0]!).deny.click()
    await page.flush()
    expect(page.calls().map(m => m.params?.["name"])).toEqual([
      "approval_card_list",
      "approval_card_decide",
      "approval_card_list",
    ])
    expect(engine.get(id)?.status).toBe("denied")
    expect(page.statusOf(page.cards()[0]!)).toBe("Refused")
  })

  it("the same cached HTML, reused for a second page, lists the current approvals", async () => {
    const { client, callTool } = await cardsHost()
    const cachedHtml = await readCardHtml(client, APPROVAL_PENDING_RESOURCE_URI)

    const first = runCardPage(cachedHtml, { callTool })
    await first.flush()
    expect(first.note.textContent).toBe("Nothing to approve")

    request("Late request")
    const second = runCardPage(cachedHtml, { callTool })
    await second.flush()
    expect(second.cards().map(c => second.titleOf(c))).toEqual(["Late request"])
    expect(second.note.textContent).toBe("")
  })

  it("with no notification, the 30 s refresh shows it too", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] })
    request("First")
    const { client, callTool } = await cardsHost()
    const cachedHtml = await readCardHtml(client, APPROVAL_PENDING_RESOURCE_URI)

    const page = runCardPage(cachedHtml, { callTool, setInterval: globalThis.setInterval })
    await page.flush()
    expect(page.cards()).toHaveLength(1)

    request("Created later")
    await page.flush()
    expect(page.cards()).toHaveLength(1)

    vi.advanceTimersByTime(30_000)
    await page.flush()
    expect(page.cards().map(c => page.titleOf(c))).toEqual(["First", "Created later"])
  })

  it("does not poll while the page is hidden", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] })
    const { client, callTool } = await cardsHost()
    const cachedHtml = await readCardHtml(client, APPROVAL_PENDING_RESOURCE_URI)
    const page = runCardPage(cachedHtml, { callTool, setInterval: globalThis.setInterval })
    await page.flush()
    const listCalls = () => page.calls("approval_card_list").length
    expect(listCalls()).toBe(1)

    page.doc.visibilityState = "hidden"
    vi.advanceTimersByTime(30_000)
    await page.flush()
    expect(listCalls()).toBe(1)

    page.doc.visibilityState = "visible"
    vi.advanceTimersByTime(30_000)
    await page.flush()
    expect(listCalls()).toBe(2)
  })

  it("drops a card whose approval was decided somewhere else", async () => {
    const a = request("Decided elsewhere")
    request("Still waiting")
    const { client, callTool } = await cardsHost()
    const page = runCardPage(await readCardHtml(client, APPROVAL_PENDING_RESOURCE_URI), { callTool })
    await page.flush()
    expect(page.cards()).toHaveLength(2)

    const { ticket } = engine.mintCardTicket(a)
    await engine.decideByCard(a, "approve", ticket, { ipAddress: "t", userAgent: "t" })
    page.notify("ui/notifications/tool-result")
    await page.flush()
    expect(page.cards().map(c => page.titleOf(c))).toEqual(["Still waiting"])
  })
})

describe("deciding from the page", () => {
  it("Approve decides through the bridge with the ticket the list handed out, then refreshes", async () => {
    const id = request("Send")
    const { client, callTool } = await cardsHost()
    const page = runCardPage(await readCardHtml(client, approvalCardResourceUri(id)), { callTool })
    await page.flush()

    const card = page.cards()[0]!
    page.buttons(card).approve.click()
    await page.flush()

    expect(engine.get(id)?.status).toBe("approved")
    expect(page.statusOf(card)).toBe("Approved")
    expect(page.actionsOf(card).style.display).toBe("none")
    expect(page.calls("approval_card_list").length).toBeGreaterThanOrEqual(2)
  })

  it("a ticket that expired: fetches a new one once, asks to click again, never retries by itself", async () => {
    const id = request("Send")
    const { client, callTool } = await cardsHost()
    const page = runCardPage(await readCardHtml(client, approvalCardResourceUri(id)), { callTool })
    await page.flush()
    const card = page.cards()[0]!

    engine.mintCardTicket(id) // supersedes the page's ticket
    const listsBefore = page.calls("approval_card_list").length
    page.buttons(card).approve.click()
    await page.flush()

    expect(engine.get(id)?.status).toBe("pending")
    expect(page.calls("approval_card_decide")).toHaveLength(1)
    expect(page.calls("approval_card_list")).toHaveLength(listsBefore + 1)
    expect(page.statusOf(card)).toBe("This card was refreshed. Click again to decide.")
    expect(page.buttons(card).approve.disabled).toBe(false)

    page.buttons(card).approve.click()
    await page.flush()
    expect(page.calls("approval_card_decide")).toHaveLength(2)
    expect(engine.get(id)?.status).toBe("approved")
  })

  it("a single card whose approval is no longer pending shows its final state, with no buttons", async () => {
    const approved = request("A")
    const denied = request("B")
    const { client, callTool } = await cardsHost()
    const cached = {
      a: await readCardHtml(client, approvalCardResourceUri(approved)),
      b: await readCardHtml(client, approvalCardResourceUri(denied)),
    }
    const ta = engine.mintCardTicket(approved).ticket
    await engine.decideByCard(approved, "approve", ta, { ipAddress: "t", userAgent: "t" })
    const tb = engine.mintCardTicket(denied).ticket
    await engine.decideByCard(denied, "deny", tb, { ipAddress: "t", userAgent: "t" })

    const pa = runCardPage(cached.a, { callTool })
    const pb = runCardPage(cached.b, { callTool })
    await pa.flush()
    await pb.flush()
    expect(pa.statusOf(pa.cards()[0]!)).toBe("Approved")
    expect(pb.statusOf(pb.cards()[0]!)).toBe("Refused")
    expect(pa.actionsOf(pa.cards()[0]!).style.display).toBe("none")
    expect(pa.metaOf(pa.cards()[0]!)).toBe("")
  })

  it("an expired approval shows Expired", async () => {
    const id = request("Soon gone", { expiresAt: new Date(Date.now() + 50).toISOString() })
    const { client, callTool } = await cardsHost()
    const html = await readCardHtml(client, approvalCardResourceUri(id))
    await new Promise(resolve => setTimeout(resolve, 80))
    const page = runCardPage(html, { callTool })
    await page.flush()
    expect(page.statusOf(page.cards()[0]!)).toBe("Expired")
  })

  it("an unknown approval id says it is no longer waiting", async () => {
    const id = request("Send")
    const { client, callTool } = await cardsHost()
    const html = (await readCardHtml(client, approvalCardResourceUri(id))).split(id).join("apr_missing")
    const page = runCardPage(html, { callTool })
    await page.flush()
    expect(page.cards()).toHaveLength(0)
    expect(page.note.textContent).toBe("This request is no longer waiting for a decision.")
  })
})

describe("expiry text shows the approval's own expiry only", () => {
  it("an approval with no expiresAt renders no expiry text", async () => {
    request("No expiry")
    const { client, callTool } = await cardsHost()
    const page = runCardPage(await readCardHtml(client, APPROVAL_PENDING_RESOURCE_URI), { callTool })
    await page.flush()
    expect(page.metaOf(page.cards()[0]!)).toBe("")
    expect(page.text()).not.toMatch(/expire/i)
  })

  it("one expiring in 10 min says so, and not the ticket's 10 min lifetime on top", async () => {
    request("Soon", { expiresAt: new Date(Date.now() + 10 * 60_000 - 5_000).toISOString() })
    request("Later", { expiresAt: new Date(Date.now() + 3 * 3_600_000).toISOString() })
    const { client, callTool } = await cardsHost()
    const page = runCardPage(await readCardHtml(client, APPROVAL_PENDING_RESOURCE_URI), { callTool })
    await page.flush()
    const [soon, later] = page.cards()
    expect(page.metaOf(soon!)).toBe("expires in 10 min")
    expect(page.metaOf(later!)).toBe("expires in 3 h")
  })
})

describe("the pending list keeps a card it decided", () => {
  async function listPage(...titles: string[]) {
    const ids = titles.map(t => request(t))
    const { client, callTool } = await cardsHost()
    const bodyHeight = { value: 100 }
    const page = runCardPage(await readCardHtml(client, APPROVAL_PENDING_RESOURCE_URI), { callTool, bodyHeight })
    await page.flush()
    return { ids, page, bodyHeight }
  }

  it("Approve leaves both cards on screen: the first reads Approved with no buttons, the second keeps its buttons", async () => {
    const { ids, page } = await listPage("First", "Second")
    const [first, second] = page.cards()
    expect(page.cards()).toHaveLength(2)

    page.buttons(first!).approve.click()
    await page.flush()

    expect(engine.get(ids[0]!)?.status).toBe("approved")
    expect(page.cards().map(c => page.titleOf(c))).toEqual(["First", "Second"])
    expect(page.cards()[0]).toBe(first)
    expect(page.statusOf(first!)).toBe("Approved")
    expect(page.actionsOf(first!).style.display).toBe("none")
    expect(page.metaOf(first!)).toBe("")
    expect(page.statusOf(second!)).toBe("")
    expect(page.actionsOf(second!).style.display).not.toBe("none")
    expect(page.buttons(second!).approve.disabled).toBe(false)
    expect(page.buttons(second!).deny.disabled).toBe(false)
  })

  it("Refuse reads Refused the same way", async () => {
    const { ids, page } = await listPage("First", "Second")
    const [first, second] = page.cards()

    page.buttons(first!).deny.click()
    await page.flush()

    expect(engine.get(ids[0]!)?.status).toBe("denied")
    expect(page.cards().map(c => page.titleOf(c))).toEqual(["First", "Second"])
    expect(page.statusOf(first!)).toBe("Refused")
    expect(page.actionsOf(first!).style.display).toBe("none")
    expect(page.actionsOf(second!).style.display).not.toBe("none")
  })

  it("never shows Nothing to approve while a decided card is on screen, and keeps the cards across later refreshes", async () => {
    const { page } = await listPage("Only", "Last")
    const [only, last] = page.cards()

    page.buttons(only!).approve.click()
    await page.flush()
    page.buttons(last!).deny.click()
    await page.flush()

    expect(page.cards()).toHaveLength(2)
    expect(page.statusOf(only!)).toBe("Approved")
    expect(page.statusOf(last!)).toBe("Refused")
    expect(page.note.textContent).toBe("")

    page.notify("ui/notifications/tool-result")
    await page.flush()
    expect(page.cards()).toHaveLength(2)
    expect(page.statusOf(only!)).toBe("Approved")
    expect(page.note.textContent).toBe("")
  })

  it("a new pending approval joins after the decided card; the height is reported after a decision", async () => {
    const { page, bodyHeight } = await listPage("Decided")
    bodyHeight.value = 180
    page.buttons(page.cards()[0]!).approve.click()
    await page.flush()
    expect(page.sizes().at(-1)).toBe(180)

    request("Newer")
    page.notify("ui/notifications/tool-result")
    await page.flush()

    expect(page.cards().map(c => page.titleOf(c))).toEqual(["Decided", "Newer"])
    expect(page.statusOf(page.cards()[0]!)).toBe("Approved")
    expect(page.buttons(page.cards()[1]!).approve.disabled).toBe(false)
  })
})
