/**
 * Standalone app UI host — GET /apps/:appId/ui serves an installed app's
 * html with the REST `window.McpApp` bridge injected, and
 * POST /apps/:appId/tool-call runs the exact `app_tool_call` chain
 * (`performAppToolCall`: ui.tools allowlist → dispatchTool/callImportedTool)
 * over REST. Exercises the real REST layer via `startHttpServer`, same
 * pattern as workspaces-http-routes.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer, type RuntimeHttpServerOptions } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createAppRegistry, type AppRegistry } from "../app-registry.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

const APP_ID = "@agentproto/media-viewer"

const APP_HTML = `<!doctype html>
<html>
<head><title>Media Viewer</title></head>
<body>
<div id="grid">media-viewer-marker</div>
<script>
window.McpApp.connect().then(function (bridge) { window.__bridge = bridge; });
</script>
</body>
</html>
`

describe("standalone app UI host — REST routes", () => {
  let dir: string
  let uiPath: string
  let appRegistry: AppRegistry
  let dispatched: Array<{ name: string; args: Record<string, unknown> }>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentproto-app-ui-"))
    uiPath = join(dir, "ui.html")
    await writeFile(uiPath, APP_HTML, "utf8")
    dispatched = []
    appRegistry = createAppRegistry()
    appRegistry.upsertApp({
      appId: APP_ID,
      dir,
      agents: [],
      workflows: [],
      unvalidatedAgentTools: [],
      ui: { path: uiPath, title: "Media Viewer", tools: ["directory_list", "file_info"] },
    })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function withServer(
    fn: (base: string) => Promise<void>,
    extra?: Partial<RuntimeHttpServerOptions>,
  ): Promise<void> {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () =>
        (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
      appRegistry,
      appToolCallDeps: {
        dispatchTool: async (name, args) => {
          dispatched.push({ name, args })
          return `dispatched:${name}`
        },
      },
      ...extra,
    })
    try {
      await fn(`http://127.0.0.1:${port}`)
    } finally {
      await http.stop()
    }
  }

  it("GET /apps/:appId/ui serves the html with the REST bridge injected", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${APP_ID}/ui`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/html")
      expect(res.headers.get("x-frame-options")).toBe("DENY")
      const html = await res.text()
      expect(html).toContain("media-viewer-marker")
      // Bridge injected before the app's own script, pointing at ./tool-call.
      expect(html.indexOf('fetch("./tool-call"')).toBeGreaterThan(-1)
      expect(html.indexOf('fetch("./tool-call"')).toBeLessThan(html.indexOf("media-viewer-marker"))
    })
  })

  it("GET with a %2F-encoded appId serves the same app", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${encodeURIComponent(APP_ID)}/ui`)
      expect(res.status).toBe(200)
      expect(await res.text()).toContain("media-viewer-marker")
    })
  })

  it("GET for an unknown app 404s", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/@nope/nothing/ui`)
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error: string }
      expect(body.error).toContain("not installed")
    })
  })

  it("POST /apps/:appId/tool-call dispatches an allowlisted tool and returns the MCP envelope", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${APP_ID}/tool-call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: "directory_list", args: { path: "." } }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { content: Array<{ type: string; text: string }>; isError?: boolean }
      expect(body.isError).toBeUndefined()
      expect(JSON.parse(body.content[0]!.text)).toBe("dispatched:directory_list")
      expect(dispatched).toEqual([{ name: "directory_list", args: { path: "." } }])
    })
  })

  it("POST refuses a tool outside the ui.tools allowlist (isError envelope, nothing dispatched)", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${APP_ID}/tool-call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: "command_execute", args: { command: "rm" } }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { content: Array<{ text: string }>; isError?: boolean }
      expect(body.isError).toBe(true)
      expect(body.content[0]!.text).toContain("allowlist")
      expect(dispatched).toEqual([])
    })
  })

  it("POST unwraps the bundled UIs' app_tool_call meta-call", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${APP_ID}/tool-call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tool: "app_tool_call",
          args: { appId: APP_ID, tool: "file_info", args: { path: "a.png" } },
        }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { content: Array<{ text: string }>; isError?: boolean }
      expect(body.isError).toBeUndefined()
      expect(dispatched).toEqual([{ name: "file_info", args: { path: "a.png" } }])
    })
  })

  it("POST refuses a meta-call naming a different app", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${APP_ID}/tool-call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tool: "app_tool_call",
          args: { appId: "@other/app", tool: "file_info" },
        }),
      })
      expect(res.status).toBe(400)
      expect(dispatched).toEqual([])
    })
  })

  it("POST with a malformed body 400s", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${APP_ID}/tool-call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ args: {} }),
      })
      expect(res.status).toBe(400)
    })
  })

  it("blocks a non-allowlisted browser origin's drive-by on both routes", async () => {
    await withServer(async base => {
      const ui = await fetch(`${base}/apps/${APP_ID}/ui`, {
        headers: { origin: "http://evil.example" },
      })
      expect(ui.status).toBe(403)
      const call = await fetch(`${base}/apps/${APP_ID}/tool-call`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://evil.example" },
        body: JSON.stringify({ tool: "directory_list" }),
      })
      expect(call.status).toBe(403)
      expect(dispatched).toEqual([])
    })
  })

  it("routes 404 when no appRegistry is wired", async () => {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () =>
        (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/apps/${APP_ID}/ui`)
      expect(res.status).toBe(404)
    } finally {
      await http.stop()
    }
  })
})

// ── tiny stubs (mirror workspaces-http-routes.test.ts) ──

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
    pathFor: (id: string) => id,
  }
}

function noopHeartbeat(): HeartbeatRunner {
  return {
    start() {},
    stop() {},
    async fireNow() {},
  }
}
