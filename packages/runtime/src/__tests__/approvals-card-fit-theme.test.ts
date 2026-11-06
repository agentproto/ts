/**
 * The approval card sizes its host frame to its content and follows the
 * host theme: it reports `ui/notifications/size-changed` after the
 * `ui/initialize` handshake and on every resize, applies `hostContext.theme`
 * and `styles.variables`, and carries no hard-coded green/red fills.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import vm from "node:vm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createSessionEventBus } from "../session-event-bus.js"
import { createApprovalsEngine, type ApprovalsEngine } from "../approvals/engine.js"
import { renderApprovalCardHtml } from "../approvals/card.js"

let home: string
let engine: ApprovalsEngine

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "approvals-card-fit-"))
  engine = createApprovalsEngine({ homeDir: home, sessionEvents: createSessionEventBus() })
})

afterEach(() => {
  engine.dispose()
  rmSync(home, { recursive: true, force: true })
})

function pendingCard(): { id: string; html: string } {
  const id = engine.request(
    { kind: "send", title: "Send this email", preview: { to: "ana@example.com", amount: 12 }, payload: { x: 1 } },
    { sessionId: "sess_abc" },
  ).id
  return { id, html: renderApprovalCardHtml(engine, id) }
}

function scriptOf(html: string): string {
  const match = html.match(/<script>([\s\S]*?)<\/script>/)
  if (!match) throw new Error("no inline script in the card")
  return match[1]!
}

interface Posted {
  jsonrpc?: string
  id?: number
  method?: string
  params?: Record<string, unknown>
}

interface FakeEl {
  textContent: string
  disabled: boolean
  style: Record<string, string>
  attrs: Record<string, string>
  listeners: Record<string, () => void>
  getAttribute(name: string): string | null
  addEventListener(type: string, fn: () => void): void
}

function fakeEl(attrs: Record<string, string> = {}): FakeEl {
  const el: FakeEl = {
    textContent: "",
    disabled: false,
    style: {},
    attrs,
    listeners: {},
    getAttribute: name => el.attrs[name] ?? null,
    addEventListener: (type, fn) => {
      el.listeners[type] = fn
    },
  }
  return el
}

/** Runs a card page's inline script against a stand-in browser that records
 *  every message posted to the host. */
function runPage(html: string, bodyHeight: { value: number }, expires?: string) {
  const posted: Posted[] = []
  const rootAttrs: Record<string, string> = {}
  const rootVars: Record<string, string> = {}
  const els: Record<string, FakeEl> = {
    approve: fakeEl(),
    deny: fakeEl(),
    actions: fakeEl(),
    status: fakeEl(),
    expiry: fakeEl(expires === undefined ? {} : { "data-expires": expires }),
  }
  let onMessage: (evt: { data: unknown }) => void = () => {}
  let resize: () => void = () => {}
  class FakeResizeObserver {
    constructor(cb: () => void) {
      resize = cb
    }
    observe(): void {}
  }
  const win = {
    parent: { postMessage: (msg: Posted) => void posted.push(msg) },
    addEventListener: (type: string, fn: (evt: { data: unknown }) => void) => {
      if (type === "message") onMessage = fn
    },
  }
  const doc = {
    documentElement: {
      setAttribute: (k: string, v: string) => void (rootAttrs[k] = v),
      style: {
        setProperty: (k: string, v: string) => void (rootVars[k] = v),
        removeProperty: (k: string) => void delete rootVars[k],
      },
    },
    body: { getBoundingClientRect: () => ({ height: bodyHeight.value }) },
    getElementById: (id: string) => els[id],
  }
  vm.runInNewContext(scriptOf(html), {
    window: win,
    document: doc,
    ResizeObserver: FakeResizeObserver,
    setInterval: () => 1,
    clearInterval: () => {},
  })
  const reply = (id: number, result: unknown) => onMessage({ data: { jsonrpc: "2.0", id, result } })
  const sizes = () => posted.filter(m => m.method === "ui/notifications/size-changed").map(m => m.params?.height)
  const flush = () => new Promise<void>(resolve => setImmediate(resolve))
  return { posted, rootAttrs, rootVars, els, onMessage: (data: unknown) => onMessage({ data }), reply, resize: () => resize(), sizes, flush }
}

describe("approval card fits its content", () => {
  it("the pending card source reports size-changed and observes the body", () => {
    const { html } = pendingCard()
    expect(html).toContain("ui/notifications/size-changed")
    expect(html).toContain("ResizeObserver")
  })

  it("posts size-changed only after the handshake, then again on resize", async () => {
    const { html } = pendingCard()
    const height = { value: 140.2 }
    const page = runPage(html, height)
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
    const { html, id } = pendingCard()
    const height = { value: 150 }
    const page = runPage(html, height)
    page.reply(1, { hostContext: {} })
    await page.flush()

    page.els.deny!.listeners.click!()
    const call = page.posted.find(m => m.method === "tools/call")
    expect(call?.params).toMatchObject({ name: "approval_card_decide", arguments: { approvalId: id, decision: "deny" } })

    height.value = 48
    page.reply(call!.id!, { content: [] })
    await page.flush()
    expect(page.els.actions!.style.display).toBe("none")
    expect(page.els.status!.textContent).toBe("Refused")
    expect(page.sizes().at(-1)).toBe(48)
  })

  it("shows a short relative expiry line", () => {
    const { html } = pendingCard()
    const soon = new Date(Date.now() + 12 * 60_000 - 5_000).toISOString()
    const page = runPage(html, { value: 100 }, soon)
    expect(page.els.expiry!.textContent).toBe("expires in 12 min")
  })

  it("the decided and not-found pages also report their size", async () => {
    const { id } = pendingCard()
    const { ticket } = engine.mintCardTicket(id)
    await engine.decideByCard(id, "approve", ticket, { ipAddress: "t", userAgent: "t" })
    for (const html of [renderApprovalCardHtml(engine, id), renderApprovalCardHtml(engine, "missing")]) {
      expect(html).toContain("ui/notifications/size-changed")
      expect(html).toContain("ResizeObserver")
      const page = runPage(html, { value: 60 })
      page.reply(1, { hostContext: { theme: "dark" } })
      await page.flush()
      expect(page.sizes()).toEqual([60])
      expect(page.rootAttrs["data-theme"]).toBe("dark")
    }
  })
})

describe("approval card follows the host theme", () => {
  it("applies hostContext.theme and styles.variables to the root", async () => {
    const { html } = pendingCard()
    const page = runPage(html, { value: 100 })
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

  it("re-applies on host-context-changed and drops variables the host no longer sends", async () => {
    const { html } = pendingCard()
    const page = runPage(html, { value: 100 })
    page.reply(1, { hostContext: { theme: "dark", styles: { variables: { "--color-text-primary": "#fafafa" } } } })
    await page.flush()

    page.onMessage({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "light" } })
    expect(page.rootAttrs["data-theme"]).toBe("light")
    expect(page.rootVars).toEqual({})
  })

  it("the CSS reads the host variables with fallbacks and has no green/red fills", () => {
    const { html } = pendingCard()
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
    expect(html).toContain(">Refuse<")
    expect(html).not.toContain(">Deny<")
  })
})
