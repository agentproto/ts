/**
 * `GET /store` — the App Store panel's short url: 302 to the builtin panel's
 * standalone `GET /apps/@agentproto/store/ui` shell (query string preserved,
 * ?install=<appId> included), never swallowed by the greedy `/apps/:appId/ui`
 * appId match. The Panel UI GET must 200 with the actual store html.
 */

import { describe, expect, it } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { startHttpServer, normalizeStoreRedirectUrl, type RuntimeHttpServerOptions } from "../http-server.js"
import { createMcpServer } from "@agentproto/mcp-server"
import { STORE_PANEL_APP_ID, resolveBuiltinPanelUi } from "../builtin-apps.js"
import { createRuntimeEvents } from "../events.js"
import { createAppRegistry } from "../app-registry.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

function noopConversations(): ConversationStore {
  return {
    async open() {},
    async appendTurn() {},
    async read() {
      return { meta: {} as never, turns: [] }
    },
    async list() {
      return []
    },
  } as unknown as ConversationStore
}

function noopHeartbeat(): HeartbeatRunner {
  return {
    start() {},
    stop() {},
    async fireNow() {},
  }
}

describe("GET /store", () => {
  it("normalizeStoreRedirectUrl preserves the query string verbatim", () => {
    expect(normalizeStoreRedirectUrl("/store")).toBe("/apps/@agentproto/store/ui")
    expect(normalizeStoreRedirectUrl("/store?a=1&b=2")).toBe("/apps/@agentproto/store/ui?a=1&b=2")
    expect(normalizeStoreRedirectUrl("/store?install=%40acme%2Fgreeter")).toBe(
      "/apps/@agentproto/store/ui?install=%40acme%2Fgreeter",
    )
  })

  it("routes 302 to the store panel's ui url and the panel's GET serves its html", async () => {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
      appRegistry: createAppRegistry(),
    } as unknown as RuntimeHttpServerOptions)
    try {
      const base = `http://127.0.0.1:${port}`
      const res = await fetch(`${base}/store`, { redirect: "manual" })
      expect(res.status).toBe(302)
      expect(res.headers.get("location")).toBe("/apps/@agentproto/store/ui")

      const res2 = await fetch(`${base}/store?install=%40acme%2Fgreeter`, { redirect: "manual" })
      expect(res2.status).toBe(302)
      expect(res2.headers.get("location")).toBe("/apps/@agentproto/store/ui?install=%40acme%2Fgreeter")

      const uiRes = await fetch(`${base}/apps/@agentproto/store/ui`)
      expect(uiRes.status).toBe(200)
      expect(uiRes.headers.get("content-type")).toContain("text/html")
      const html = await uiRes.text()
      expect(html.length).toBeGreaterThan(0)
      expect(html).toContain("App Store")
    } finally {
      await http.stop()
    }
  })

  it("resolveBuiltinPanelUi names the store panel's own allowlist", () => {
    const ui = resolveBuiltinPanelUi(STORE_PANEL_APP_ID, "http://127.0.0.1:0")
    expect(ui).toBeDefined()
    expect(ui!.tools).toContain("app_install")
    expect(ui!.tools).toContain("app_uninstall")
    expect(ui!.html).toContain("App Store")
  })
})
