// @vitest-environment jsdom
/**
 * Sandbox-origin mode of mountMcpApp (MCP Apps spec: the view is a document on
 * an origin that differs from the host's, with `allow-same-origin`), the
 * restricted fallback, and the origin-pinned transport.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  createDaemonSandboxResolver,
  MCP_APP_SANDBOX,
  MCP_APP_SANDBOX_ORIGIN,
  mountMcpApp,
  type McpAppSandboxResolver,
  type MountedMcpApp,
} from "../dom.js"

const VIEW = { url: "http://tok.sandbox.localhost:18790/v/tok", origin: "http://tok.sandbox.localhost:18790" }
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "ui/initialize",
  params: { appInfo: { name: "view", version: "1.0.0" }, appCapabilities: {}, protocolVersion: "2026-01-26" },
}

const mounted: MountedMcpApp[] = []
let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(async () => {
  for (const m of mounted.splice(0)) await m.dispose()
  document.body.innerHTML = ""
  warn.mockRestore()
  vi.unstubAllGlobals()
})

async function mount(sandbox: McpAppSandboxResolver | false | undefined): Promise<MountedMcpApp> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const m = await mountMcpApp({
    container,
    ui: { html: "<p>x</p>", csp: { connectDomains: ["https://api.example.com"] } },
    hostInfo: { name: "test-host", version: "1.0.0" },
    hostContext: { displayMode: "inline" },
    handlers: { callTool: async () => ({ content: [] }) },
    ...(sandbox === undefined ? {} : { sandbox }),
  })
  mounted.push(m)
  return m
}

describe("mountMcpApp — sandbox-origin mode", () => {
  it("loads the view by URL with allow-same-origin and no srcdoc", async () => {
    const resolver = vi.fn<McpAppSandboxResolver>(async () => VIEW)
    const m = await mount(resolver)
    expect(m.mode).toBe("sandbox-origin")
    expect(m.iframe.getAttribute("src")).toBe(VIEW.url)
    expect(m.iframe.hasAttribute("srcdoc")).toBe(false)
    expect(m.iframe.getAttribute("sandbox")).toBe(MCP_APP_SANDBOX_ORIGIN)
    expect(m.iframe.getAttribute("sandbox")).toContain("allow-same-origin")
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ html: "<p>x</p>" }))
    expect(warn).not.toHaveBeenCalled()
  })

  it("only accepts messages from the iframe window AND the sandbox origin", async () => {
    const m = await mount(async () => VIEW)
    const inbox: unknown[] = []
    const post = vi.spyOn(m.iframe.contentWindow as Window, "postMessage")
    // Right window, wrong origin → ignored.
    window.dispatchEvent(
      new MessageEvent("message", { data: INITIALIZE, source: m.iframe.contentWindow, origin: "https://evil.example.com" }),
    )
    // Wrong window, right origin → ignored.
    window.dispatchEvent(new MessageEvent("message", { data: INITIALIZE, source: window, origin: VIEW.origin }))
    await new Promise((r) => setTimeout(r, 30))
    expect(post).not.toHaveBeenCalled()
    // Right window and right origin → answered.
    window.dispatchEvent(
      new MessageEvent("message", { data: INITIALIZE, source: m.iframe.contentWindow, origin: VIEW.origin }),
    )
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1), { timeout: 2000 })
    void inbox
  })

  it("addresses every outgoing message to the sandbox origin, never \"*\" (R5)", async () => {
    const m = await mount(async () => VIEW)
    const post = vi.spyOn(m.iframe.contentWindow as Window, "postMessage")
    window.dispatchEvent(
      new MessageEvent("message", { data: INITIALIZE, source: m.iframe.contentWindow, origin: VIEW.origin }),
    )
    await vi.waitFor(() => expect(post).toHaveBeenCalled(), { timeout: 2000 })
    for (const call of post.mock.calls) expect(call[1]).toBe(VIEW.origin)
  })
})

describe("mountMcpApp — restricted fallback", () => {
  it("resolver says null: opaque srcdoc, no allow-same-origin, a clear log line", async () => {
    const m = await mount(async () => null)
    expect(m.mode).toBe("restricted")
    expect(m.iframe.getAttribute("sandbox")).toBe(MCP_APP_SANDBOX)
    expect(m.iframe.getAttribute("sandbox")).not.toContain("allow-same-origin")
    expect(m.iframe.srcdoc).toContain("Content-Security-Policy")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("restricted mode"))
  })

  it("a custom resolver cannot hand the view the host's own origin (enforced at mount)", async () => {
    const m = await mount(async () => ({
      url: `${window.location.origin}/v/x`,
      origin: window.location.origin,
    }))
    expect(m.mode).toBe("restricted")
    expect(m.iframe.getAttribute("sandbox")).not.toContain("allow-same-origin")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("host's own origin"))
  })

  it("a resolver whose url does not match its origin, or is not http(s), is refused", async () => {
    for (const bad of [
      { url: "http://a.example.com/v/x", origin: "http://b.example.com" },
      { url: "javascript:alert(1)", origin: "null" },
      { url: "not a url", origin: "http://a.example.com" },
    ]) {
      const m = await mount(async () => bad)
      expect(m.mode, bad.url).toBe("restricted")
    }
  })

  it("resolver throws: same fallback", async () => {
    const m = await mount(async () => {
      throw new Error("boom")
    })
    expect(m.mode).toBe("restricted")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("restricted mode"))
  })

  it("sandbox:false never calls anything", async () => {
    const f = vi.fn()
    vi.stubGlobal("fetch", f)
    const m = await mount(false)
    expect(m.mode).toBe("restricted")
    expect(f).not.toHaveBeenCalled()
  })
})

describe("createDaemonSandboxResolver", () => {
  const base = "http://127.0.0.1:18790"
  const ui = { html: "<p>x</p>", csp: undefined, permissions: undefined }
  const reply = (body: unknown, ok = true): typeof fetch =>
    (async () => ({ ok, json: async () => body })) as unknown as typeof fetch

  it("posts the view and returns the sandbox URL", async () => {
    const fetchMock = vi.fn(reply({ url: VIEW.url }))
    const r = createDaemonSandboxResolver({ baseUrl: base, fetch: fetchMock })
    expect(await r(ui)).toEqual(VIEW)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${base}/mcp-app-sandbox/views`)
    expect(init.method).toBe("POST")
  })

  it("refuses a URL on the host's own origin (the one property that matters)", async () => {
    const r = createDaemonSandboxResolver({ baseUrl: base, fetch: reply({ url: `${base}/v/abc` }) })
    expect(await r(ui)).toBeNull()
  })

  it("returns null for http errors, bad JSON, non-http schemes and network failures", async () => {
    expect(await createDaemonSandboxResolver({ baseUrl: base, fetch: reply({}, false) })(ui)).toBeNull()
    expect(await createDaemonSandboxResolver({ baseUrl: base, fetch: reply({ nope: 1 }) })(ui)).toBeNull()
    expect(await createDaemonSandboxResolver({ baseUrl: base, fetch: reply({ url: "javascript:alert(1)" }) })(ui)).toBeNull()
    expect(await createDaemonSandboxResolver({ baseUrl: base, fetch: reply({ url: "not a url" }) })(ui)).toBeNull()
    const failing = (async () => {
      throw new Error("net")
    }) as unknown as typeof fetch
    expect(await createDaemonSandboxResolver({ baseUrl: base, fetch: failing })(ui)).toBeNull()
  })
})

describe("mountMcpApp — auto discovery", () => {
  it("probes the page's own origin once, then remembers it is unavailable", async () => {
    const f = vi.fn(async () => ({ ok: false, json: async () => ({}) }))
    vi.stubGlobal("fetch", f)
    const a = await mount(undefined)
    const b = await mount(undefined)
    expect(a.mode).toBe("restricted")
    expect(b.mode).toBe("restricted")
    expect(f).toHaveBeenCalledTimes(1)
    expect(String((f.mock.calls as unknown[][])[0]?.[0])).toBe(`${window.location.origin}/mcp-app-sandbox/views`)
  })
})
