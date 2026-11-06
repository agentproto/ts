/**
 * MCP Apps hosts (Claude Desktop) drop a `ui/initialize` whose params do not
 * match the ext-apps McpUiInitializeRequest schema (`appInfo`,
 * `appCapabilities`, `protocolVersion`): the card then never renders. The
 * approval card pages and the terminal panel must send the spec shape, show
 * their content before the host answers, and keep the buttons disabled until
 * the handshake has succeeded.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import vm from "node:vm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { renderApprovalCardHtml, renderPendingApprovalsHtml } from "../approvals/card.js"
import { createApprovalsEngine, type ApprovalsEngine } from "../approvals/engine.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { makeTerminalPanelApp } from "../terminal-panel-app.js"

let home: string
let engine: ApprovalsEngine

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "approvals-card-handshake-"))
  engine = createApprovalsEngine({ homeDir: home, sessionEvents: createSessionEventBus() })
})

afterEach(() => {
  engine.dispose()
  rmSync(home, { recursive: true, force: true })
})

interface Posted {
  id?: number
  method?: string
  params?: Record<string, unknown>
}

interface FakeEl {
  textContent: string
  disabled: boolean
  hidden: boolean
  style: Record<string, string>
  getAttribute(name: string): string | null
  addEventListener(type: string, fn: () => void): void
  remove(): void
}

function fakeEl(startDisabled: boolean): FakeEl {
  return {
    textContent: "",
    disabled: startDisabled,
    hidden: false,
    style: {},
    getAttribute: () => null,
    addEventListener() {},
    remove() {},
  }
}

function scriptOf(html: string): string {
  return html.match(/<script>([\s\S]*?)<\/script>/)![1]!
}

/** Runs the page script; buttons start disabled exactly like the markup. */
function runPage(html: string) {
  const posted: Posted[] = []
  const els = new Map<string, FakeEl>()
  const get = (id: string): FakeEl => {
    let el = els.get(id)
    if (!el) {
      el = fakeEl(/^(approve|deny)/.test(id))
      els.set(id, el)
    }
    return el
  }
  let onMessage: (evt: { data: unknown; source?: unknown }) => void = () => {}
  const parent = { postMessage: (msg: Posted) => void posted.push(msg) }
  vm.runInNewContext(scriptOf(html), {
    window: {
      parent,
      addEventListener: (type: string, fn: typeof onMessage) => {
        if (type === "message") onMessage = fn
      },
    },
    document: {
      documentElement: { setAttribute() {}, style: { setProperty() {}, removeProperty() {} } },
      body: { getBoundingClientRect: () => ({ height: 100 }) },
      getElementById: get,
    },
    ResizeObserver: class {
      observe(): void {}
    },
    setInterval: () => 1,
    clearInterval: () => {},
  })
  const reply = (id: number, result: unknown) => onMessage({ data: { jsonrpc: "2.0", id, result }, source: parent })
  const reject = (id: number) =>
    onMessage({ data: { jsonrpc: "2.0", id, error: { code: -32600, message: "bad" } }, source: parent })
  const flush = () => new Promise<void>(resolve => setImmediate(resolve))
  return { posted, get, reply, reject, flush }
}

function request(title: string): string {
  return engine.request(
    { kind: "send", title, preview: { to: "ana@example.com" }, payload: { x: 1 } },
    { sessionId: "sess_abc" },
  ).id
}

function initParams(page: ReturnType<typeof runPage>): Record<string, unknown> {
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
    const html = renderApprovalCardHtml(engine, request("Send"))
    expect(html).not.toContain("clientInfo")
    expectSpecHandshake(initParams(runPage(html)))
  })

  it("the pending list sends appInfo, never clientInfo", () => {
    request("First")
    request("Second")
    const html = renderPendingApprovalsHtml(engine)
    expect(html).not.toContain("clientInfo")
    expectSpecHandshake(initParams(runPage(html)))
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

describe("card content before the handshake", () => {
  it("renders title, details and buttons in the static markup, buttons disabled", () => {
    const html = renderApprovalCardHtml(engine, request("Send this email"))
    const markup = html.slice(0, html.indexOf("<script>"))
    expect(markup).toContain("Send this email")
    expect(markup).toContain("ana@example.com")
    expect(markup).toContain('<button id="approve" class="primary" disabled>')
    expect(markup).toContain('<button id="deny" disabled>')
  })

  it("the pending list markup has every card with disabled buttons", () => {
    request("First")
    request("Second")
    const html = renderPendingApprovalsHtml(engine)
    const markup = html.slice(0, html.indexOf("<script>"))
    expect(markup).toContain("First")
    expect(markup).toContain("Second")
    expect(markup.match(/<button id="approve-\d" class="primary" disabled>/g)).toHaveLength(2)
    expect(markup.match(/<button id="deny-\d" disabled>/g)).toHaveLength(2)
  })

  it("the card enables its buttons only once the handshake succeeded", async () => {
    const page = runPage(renderApprovalCardHtml(engine, request("Send")))
    expect(page.get("approve").disabled).toBe(true)
    expect(page.get("deny").disabled).toBe(true)
    page.reply(1, { hostContext: {} })
    await page.flush()
    expect(page.get("approve").disabled).toBe(false)
    expect(page.get("deny").disabled).toBe(false)
  })

  it("the card keeps its buttons disabled when the host rejects the handshake", async () => {
    const page = runPage(renderApprovalCardHtml(engine, request("Send")))
    page.reject(1)
    await page.flush()
    expect(page.get("approve").disabled).toBe(true)
    expect(page.get("deny").disabled).toBe(true)
  })

  it("the pending list enables every card's buttons once the handshake succeeded", async () => {
    request("First")
    request("Second")
    const page = runPage(renderPendingApprovalsHtml(engine))
    expect(page.get("approve-0").disabled).toBe(true)
    expect(page.get("deny-1").disabled).toBe(true)
    page.reply(1, { hostContext: {} })
    await page.flush()
    for (const id of ["approve-0", "deny-0", "approve-1", "deny-1"]) expect(page.get(id).disabled).toBe(false)
  })
})
