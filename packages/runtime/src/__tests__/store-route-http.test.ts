/**
 * `GET /store` — the App Store panel's short url: 302 to the builtin panel's
 * standalone `GET /apps/@agentproto/store/ui` shell (query string preserved,
 * ?install=<appId> included), never swallowed by the greedy `/apps/:appId/ui`
 * appId match. The Panel UI GET must 200 with the actual store html.
 *
 * When the first-party `@agentproto/app-store` app is installed (with a UI
 * and an existing dir), `/store` redirects to it instead, so a machine shows
 * one storefront, not the builtin panel next to the installed app.
 */

import { describe, expect, it } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import {
  startHttpServer,
  INSTALLED_STORE_APP_ID,
  normalizeStoreRedirectUrl,
  resolveStoreRedirectUrl,
  type RuntimeHttpServerOptions,
} from "../http-server.js"
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

describe("GET /store with the installed App Store app", () => {
  // The implementation's own constant, so the test follows it if it moves.
  const INSTALLED_ID = INSTALLED_STORE_APP_ID
  const STOREFRONT_MARKER = "installed-storefront-page"

  async function withInstalledStore(
    install: boolean,
    fn: (base: string) => Promise<void>,
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "agentproto-store-route-"))
    const appRegistry = createAppRegistry()
    if (install) {
      // A real bundle, so the redirect target can be fetched and served.
      await mkdir(join(dir, "ui", "dist"), { recursive: true })
      await writeFile(
        join(dir, "ui", "dist", "index.html"),
        `<!doctype html><html><head></head><body>${STOREFRONT_MARKER}</body></html>`,
      )
      appRegistry.upsertApp({
        appId: INSTALLED_ID,
        dir,
        agents: [],
        workflows: [],
        unvalidatedAgentTools: [],
        // Absolute, as an install record stores it (resolved against the app dir).
        ui: { path: join(dir, "ui", "dist", "index.html") },
      })
    }
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
      appRegistry,
    } as unknown as RuntimeHttpServerOptions)
    try {
      await fn(`http://127.0.0.1:${port}`)
    } finally {
      await http.stop()
      await rm(dir, { recursive: true, force: true })
    }
  }

  it("redirects to the installed app, query preserved, so there is one storefront", async () => {
    await withInstalledStore(true, async base => {
      const res = await fetch(`${base}/store?install=%40acme%2Fgreeter`, { redirect: "manual" })
      expect(res.status).toBe(302)
      const location = res.headers.get("location")
      expect(location).toBe("/apps/@agentproto/app-store/ui?install=%40acme%2Fgreeter")
      // Follow the redirect: the target really serves the installed app.
      const page = await fetch(`${base}${location}`)
      expect(page.status).toBe(200)
      expect(await page.text()).toContain(STOREFRONT_MARKER)
    })
  })

  it("falls back to the builtin panel when the installed app is absent", async () => {
    await withInstalledStore(false, async base => {
      const res = await fetch(`${base}/store`, { redirect: "manual" })
      expect(res.headers.get("location")).toBe("/apps/@agentproto/store/ui")
    })
  })

  it("resolveStoreRedirectUrl ignores an installed record without a UI or with a missing dir", () => {
    const reg = createAppRegistry()
    reg.upsertApp({ appId: INSTALLED_ID, dir: "/nonexistent-dir-xyz", agents: [], workflows: [], unvalidatedAgentTools: [], ui: { path: "ui/index.html" } })
    expect(resolveStoreRedirectUrl("/store", reg)).toBe("/apps/@agentproto/store/ui")
    const noUi = createAppRegistry()
    noUi.upsertApp({ appId: INSTALLED_ID, dir: tmpdir(), agents: [], workflows: [], unvalidatedAgentTools: [] })
    expect(resolveStoreRedirectUrl("/store", noUi)).toBe("/apps/@agentproto/store/ui")
  })

  it("resolveStoreRedirectUrl keeps the builtin panel when the bundle is gone and cannot be rebuilt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentproto-store-nobundle-"))
    try {
      const gone = createAppRegistry()
      gone.upsertApp({ appId: INSTALLED_ID, dir, agents: [], workflows: [], unvalidatedAgentTools: [], ui: { path: join(dir, "ui", "dist", "index.html") } })
      expect(resolveStoreRedirectUrl("/store", gone)).toBe("/apps/@agentproto/store/ui")
      // A declared build can produce the bundle: the installed app is the target.
      const buildable = createAppRegistry()
      buildable.upsertApp({
        appId: INSTALLED_ID,
        dir,
        agents: [],
        workflows: [],
        unvalidatedAgentTools: [],
        ui: { path: join(dir, "ui", "dist", "index.html"), build: { command: "true" } },
      })
      expect(resolveStoreRedirectUrl("/store", buildable)).toBe("/apps/@agentproto/app-store/ui")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
