/**
 * The approval card sizes its host frame to its content and follows the
 * host theme: it reports `ui/notifications/size-changed` after the
 * `ui/initialize` handshake and on every resize, applies `hostContext.theme`
 * and `styles.variables`, and carries no hard-coded green/red fills.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createSessionEventBus } from "../session-event-bus.js"
import { createApprovalsEngine, type ApprovalsEngine } from "../approvals/engine.js"
import { approvalCardResourceUri, renderApprovalCardHtml } from "../approvals/card.js"
import { connectCards, readCardHtml, runCardPage } from "./helpers/approvals-card-page.js"

let home: string
let engine: ApprovalsEngine
let closeCards: (() => Promise<void>) | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "approvals-card-fit-"))
  engine = createApprovalsEngine({ homeDir: home, sessionEvents: createSessionEventBus() })
})

afterEach(async () => {
  await closeCards?.()
  closeCards = undefined
  engine.dispose()
  rmSync(home, { recursive: true, force: true })
})

function request(expiresAt?: string): string {
  return engine.request(
    {
      kind: "send",
      title: "Send this email",
      preview: { to: "ana@example.com", amount: 12 },
      payload: { x: 1 },
      ...(expiresAt ? { expiresAt } : {}),
    },
    { sessionId: "sess_abc" },
  ).id
}

/** The card template (which holds no approval) wired to a real cards surface. */
async function pendingCard(opts: { bodyHeight?: { value: number }; autoInit?: boolean; expiresAt?: string } = {}) {
  const id = request(opts.expiresAt)
  const host = await connectCards(engine)
  closeCards = host.close
  const html = await readCardHtml(host.client, approvalCardResourceUri(id))
  const page = runCardPage(html, {
    callTool: host.callTool,
    ...(opts.bodyHeight ? { bodyHeight: opts.bodyHeight } : {}),
    ...(opts.autoInit !== undefined ? { autoInit: opts.autoInit } : {}),
  })
  return { id, html, page }
}

/** Just the template, with no host to answer its tool calls. */
function bareCard(opts: { bodyHeight?: { value: number } } = {}) {
  const html = renderApprovalCardHtml("apr_x")
  return { html, page: runCardPage(html, { autoInit: false, ...opts }) }
}

describe("approval card fits its content", () => {
  it("the card source reports size-changed and observes the body", () => {
    const html = renderApprovalCardHtml("apr_x")
    expect(html).toContain("ui/notifications/size-changed")
    expect(html).toContain("ResizeObserver")
  })

  it("posts size-changed only after the handshake, then again on resize", async () => {
    const height = { value: 140.2 }
    const { page } = bareCard({ bodyHeight: height })
    expect(page.posted[0]).toMatchObject({ method: "ui/initialize", id: 1 })
    expect(page.sizes()).toEqual([])

    page.reply(1, { hostContext: { theme: "light" } })
    await page.flush()
    expect(page.posted.some(m => m.method === "ui/notifications/initialized")).toBe(true)
    expect(page.sizes()).toEqual([141])

    height.value = 96
    page.resize()
    expect(page.sizes()).toEqual([141, 96])

    page.resize()
    expect(page.sizes()).toEqual([141, 96])
  })

  it("shrinks after a decision: actions hidden, one result line, new size reported", async () => {
    const height = { value: 150 }
    const { page, id } = await pendingCard({ bodyHeight: height })
    await page.flush()

    height.value = 48
    page.buttons(page.cards()[0]!).deny.click()
    expect(page.calls("approval_card_decide")[0]?.params).toMatchObject({
      name: "approval_card_decide",
      arguments: { approvalId: id, decision: "deny" },
    })
    await page.flush()

    const card = page.cards()[0]!
    expect(page.actionsOf(card).style.display).toBe("none")
    expect(page.statusOf(card)).toBe("Refused")
    expect(page.sizes().at(-1)).toBe(48)
  })

  it("shows a short relative expiry line", async () => {
    const soon = new Date(Date.now() + 12 * 60_000 - 5_000).toISOString()
    const { page } = await pendingCard({ expiresAt: soon })
    await page.flush()
    expect(page.metaOf(page.cards()[0]!)).toBe("expires in 12 min")
  })

  it("the decided and not-found pages also report their size", async () => {
    const id = request()
    const ticket = engine.mintCardTicket(id).ticket
    await engine.decideByCard(id, "approve", ticket, { ipAddress: "t", userAgent: "t" })
    const host = await connectCards(engine)
    closeCards = host.close
    for (const target of [id, "apr_missing"]) {
      const html = renderApprovalCardHtml(target)
      expect(html).toContain("ui/notifications/size-changed")
      expect(html).toContain("ResizeObserver")
      const page = runCardPage(html, { callTool: host.callTool, autoInit: false, bodyHeight: { value: 60 } })
      page.reply(1, { hostContext: { theme: "dark" } })
      await page.flush()
      expect(page.sizes()).toEqual([60])
      expect(page.rootAttrs["data-theme"]).toBe("dark")
    }
  })
})

describe("approval card follows the host theme", () => {
  it("applies hostContext.theme and styles.variables to the root", async () => {
    const { page } = bareCard()
    page.reply(1, {
      hostContext: {
        theme: "dark",
        styles: { variables: { "--color-text-primary": "#fafafa", "--font-sans": "Inter", "not-a-var": "x", "--bad": 3 } },
      },
    })
    await page.flush()
    expect(page.rootAttrs["data-theme"]).toBe("dark")
    expect(page.rootVars).toEqual({ "--color-text-primary": "#fafafa", "--font-sans": "Inter" })
  })

  it("a partial host-context-changed keeps the variables applied earlier", async () => {
    const { page } = bareCard()
    page.reply(1, {
      hostContext: {
        theme: "dark",
        styles: { variables: { "--color-text-primary": "#fafafa", "--font-sans": "Inter" } },
      },
    })
    await page.flush()

    page.notify("ui/notifications/host-context-changed", {
      styles: { variables: { "--color-text-primary": "#111111", "--color-border-primary": "#333333" } },
    })
    expect(page.rootAttrs["data-theme"]).toBe("dark")
    expect(page.rootVars).toEqual({
      "--color-text-primary": "#111111",
      "--font-sans": "Inter",
      "--color-border-primary": "#333333",
    })
  })

  it("a theme-only host-context-changed switches the theme and keeps the variables", async () => {
    const { page } = bareCard()
    page.reply(1, { hostContext: { theme: "dark", styles: { variables: { "--color-text-primary": "#fafafa" } } } })
    await page.flush()

    page.notify("ui/notifications/host-context-changed", { theme: "light" })
    expect(page.rootAttrs["data-theme"]).toBe("light")
    expect(page.rootVars).toEqual({ "--color-text-primary": "#fafafa" })
  })

  it("the CSS reads the host variables with fallbacks and has no green/red fills", () => {
    const { html } = bareCard()
    const css = html.match(/<style>([\s\S]*?)<\/style>/)![1]!
    for (const name of [
      "--color-text-primary",
      "--color-text-secondary",
      "--color-border-primary",
      "--color-background-primary",
      "--font-sans",
    ]) {
      expect(css).toMatch(new RegExp(`var\\(${name},\\s*[^)]+`))
    }
    expect(css).toContain("prefers-color-scheme: dark")
    expect(css).toMatch(/html, body \{ background: transparent/)
    expect(html).not.toMatch(/#16a34a|#dc2626/i)
    expect(html).toContain("Refuse")
    expect(html).not.toContain(">Deny<")
  })

  it("ignores responses and host-context-changed that do not come from window.parent", async () => {
    const { page } = bareCard()
    const stranger = { postMessage: () => {} }

    page.deliver(
      { jsonrpc: "2.0", id: 1, result: { hostContext: { theme: "dark", styles: { variables: { "--color-text-primary": "#fafafa" } } } } },
      stranger,
    )
    page.deliver({ jsonrpc: "2.0", id: 1, result: { hostContext: { theme: "dark" } } }, undefined)
    await page.flush()
    expect(page.posted.some(m => m.method === "ui/notifications/initialized")).toBe(false)
    expect(page.rootAttrs["data-theme"]).toBeUndefined()
    expect(page.rootVars).toEqual({})

    page.reply(1, { hostContext: { theme: "light" } })
    await page.flush()
    page.deliver({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "dark" } }, stranger)
    expect(page.rootAttrs["data-theme"]).toBe("light")
  })

  it("ignores a ui/notifications/tool-result that does not come from window.parent", async () => {
    const { page } = bareCard()
    page.reply(1, { hostContext: {} })
    await page.flush()
    const before = page.calls("approval_card_list").length
    page.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {} }, { postMessage: () => {} })
    expect(page.calls("approval_card_list").length).toBe(before)
  })
})
