/**
 * MCP Apps hosts (Claude Desktop) drop a `ui/initialize` whose params do not
 * match the ext-apps McpUiInitializeRequest schema (`appInfo`,
 * `appCapabilities`, `protocolVersion`): the card then never renders. The
 * approval card pages and the terminal panel must send the spec shape, fetch
 * their cards only once the host answered, and keep the buttons disabled until
 * the handshake has succeeded and the card has its ticket.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { renderApprovalCardHtml, renderPendingApprovalsHtml } from "../approvals/card.js"
import { createApprovalsEngine, type ApprovalsEngine } from "../approvals/engine.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { makeTerminalPanelApp } from "../terminal-panel-app.js"
import { connectCards, runCardPage, type CardPage } from "./helpers/approvals-card-page.js"

let home: string
let engine: ApprovalsEngine
let closeCards: (() => Promise<void>) | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "approvals-card-handshake-"))
  engine = createApprovalsEngine({ homeDir: home, sessionEvents: createSessionEventBus() })
})

afterEach(async () => {
  await closeCards?.()
  closeCards = undefined
  engine.dispose()
  rmSync(home, { recursive: true, force: true })
})

function request(title: string): string {
  return engine.request(
    { kind: "send", title, preview: { to: "ana@example.com" }, payload: { x: 1 } },
    { sessionId: "sess_abc" },
  ).id
}

function initParams(page: CardPage): Record<string, unknown> {
  const init = page.posted.find(m => m.method === "ui/initialize")
  expect(init).toBeDefined()
  return init!.params!
}

function expectSpecHandshake(params: Record<string, unknown>): void {
  expect(Object.keys(params).sort()).toEqual(["appCapabilities", "appInfo", "protocolVersion"])
  expect(params.appInfo).toMatchObject({ name: expect.any(String), version: expect.any(String) })
  expect(params.protocolVersion).toBe("2026-01-26")
  expect(params.appCapabilities).toEqual({ availableDisplayModes: ["inline"] })
}

describe("ui/initialize handshake shape", () => {
  it("the per-approval card sends appInfo, never clientInfo", () => {
    const html = renderApprovalCardHtml(request("Send"))
    expect(html).not.toContain("clientInfo")
    expectSpecHandshake(initParams(runCardPage(html, { autoInit: false })))
  })

  it("the pending list sends appInfo, never clientInfo", () => {
    const html = renderPendingApprovalsHtml()
    expect(html).not.toContain("clientInfo")
    expectSpecHandshake(initParams(runCardPage(html, { autoInit: false })))
  })

  it("the terminal panel sends appInfo, never clientInfo", () => {
    const app = makeTerminalPanelApp({
      spawnOrAttach: async () => ({ sessionId: "s" }),
      wsBaseUrl: "ws://127.0.0.1:1",
    })
    if (typeof app.html !== "function") throw new Error("terminal panel html must be a function")
    const html = app.html({ sessionId: "s", wsUrl: "ws://127.0.0.1:1/x", token: "", cols: 80, rows: 24 })
    expect(html).not.toContain("clientInfo")
    expect(html).toContain("appInfo")
  })
})

describe("cards and buttons wait for the handshake", () => {
  it("asks for no cards, and shows none, before the host answered", () => {
    request("Send")
    const page = runCardPage(renderPendingApprovalsHtml(), { autoInit: false })
    expect(page.calls()).toHaveLength(0)
    expect(page.cards()).toHaveLength(0)
  })

  it("lists the cards after the handshake, with the buttons enabled once the ticket is there", async () => {
    request("First")
    request("Second")
    const host = await connectCards(engine)
    closeCards = host.close
    const page = runCardPage(renderPendingApprovalsHtml(), { callTool: host.callTool, autoInit: false })

    page.reply(1, { hostContext: {} })
    await page.flush()
    expect(page.calls("approval_card_list")).toHaveLength(1)
    expect(page.cards()).toHaveLength(2)
    for (const card of page.cards()) {
      expect(page.buttons(card).approve.disabled).toBe(false)
      expect(page.buttons(card).deny.disabled).toBe(false)
    }
  })

  it("keeps a card's buttons disabled while it has no ticket", async () => {
    const id = request("Send")
    const host = await connectCards(engine)
    closeCards = host.close
    const ticket = engine.mintCardTicket(id).ticket
    await engine.decideByCard(id, "approve", ticket, { ipAddress: "t", userAgent: "t" })

    const page = runCardPage(renderApprovalCardHtml(id), { callTool: host.callTool })
    await page.flush()
    const card = page.cards()[0]!
    expect(page.buttons(card).approve.disabled).toBe(true)
    expect(page.buttons(card).deny.disabled).toBe(true)
  })

  it("keeps everything off when the host rejects the handshake", async () => {
    request("Send")
    const host = await connectCards(engine)
    closeCards = host.close
    const page = runCardPage(renderApprovalCardHtml(request("Other")), { callTool: host.callTool, autoInit: false })
    page.reject(1)
    await page.flush()
    expect(page.calls()).toHaveLength(0)
    expect(page.cards()).toHaveLength(0)
    expect(page.note.textContent).toBe("Could not load. Try again.")
  })
})
