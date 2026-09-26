// @vitest-environment jsdom
/**
 * mountMcpApp in a real (jsdom) document: iframe attributes, and that the
 * PostMessageTransport is pinned to the iframe's own window — a message from
 * any other source is ignored, one from the iframe gets an answer posted
 * back into it.
 */
import { afterEach, describe, expect, it } from "vitest"

import { buildCspMeta, MCP_APP_SANDBOX, mountMcpApp, type MountedMcpApp } from "../dom.js"

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "ui/initialize",
  params: {
    appInfo: { name: "view", version: "1.0.0" },
    appCapabilities: {},
    protocolVersion: "2026-01-26",
  },
}

const mounted: MountedMcpApp[] = []
afterEach(async () => {
  for (const m of mounted.splice(0)) await m.dispose()
  document.body.innerHTML = ""
})

async function mount(ui: Parameters<typeof mountMcpApp>[0]["ui"]): Promise<MountedMcpApp> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const m = await mountMcpApp({
    container,
    ui,
    hostInfo: { name: "test-host", version: "1.0.0" },
    hostContext: { displayMode: "inline" },
    handlers: { callTool: async () => ({ content: [] }) },
  })
  mounted.push(m)
  return m
}

/** Collect what the host posts INTO the iframe's window. */
function captureViewInbox(iframe: HTMLIFrameElement): unknown[] {
  const inbox: unknown[] = []
  iframe.contentWindow?.addEventListener("message", (e) => inbox.push(e.data))
  return inbox
}

const tick = () => new Promise((r) => setTimeout(r, 20))

describe("mountMcpApp", () => {
  it("mounts a srcdoc iframe with the sandbox (no allow-same-origin), allow and CSP", async () => {
    const { iframe } = await mount({
      html: "<html><head><title>v</title></head><body>view</body></html>",
      csp: { connectDomains: ["https://api.example.com"] },
      permissions: { camera: {}, clipboardWrite: {} },
    })
    expect(iframe.isConnected).toBe(true)
    expect(iframe.getAttribute("sandbox")).toBe(MCP_APP_SANDBOX)
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin")
    expect(iframe.getAttribute("allow")).toBe("camera; clipboard-write")
    expect(iframe.srcdoc).toBe(
      `<html><head>${buildCspMeta({ connectDomains: ["https://api.example.com"] })}<title>v</title></head><body>view</body></html>`,
    )
  })

  it("sets no allow attribute when nothing is requested", async () => {
    const { iframe } = await mount({ html: "<p>x</p>" })
    expect(iframe.hasAttribute("allow")).toBe(false)
  })

  it("answers ui/initialize from the iframe's window", async () => {
    const { iframe } = await mount({ html: "<p>x</p>" })
    const inbox = captureViewInbox(iframe)
    window.dispatchEvent(new MessageEvent("message", { data: INITIALIZE, source: iframe.contentWindow }))
    await tick()
    expect(inbox).toHaveLength(1)
    expect(inbox[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { hostInfo: { name: "test-host", version: "1.0.0" }, hostContext: { displayMode: "inline" } },
    })
  })

  it("ignores the same message from any other source", async () => {
    const { iframe } = await mount({ html: "<p>x</p>" })
    const other = await mount({ html: "<p>other</p>" })
    const inbox = captureViewInbox(iframe)
    window.dispatchEvent(
      new MessageEvent("message", { data: INITIALIZE, source: other.iframe.contentWindow }),
    )
    window.dispatchEvent(new MessageEvent("message", { data: INITIALIZE, source: null }))
    await tick()
    expect(inbox).toEqual([])
  })

  it("dispose removes the iframe and is idempotent", async () => {
    const m = await mount({ html: "<p>x</p>" })
    await Promise.all([m.dispose(), m.dispose()])
    expect(m.iframe.isConnected).toBe(false)
  })
})
