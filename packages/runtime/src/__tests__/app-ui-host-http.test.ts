/**
 * Standalone app UI host — GET /apps/:appId/ui serves an installed app's
 * html with the REST `window.McpApp` bridge injected, and
 * POST /apps/:appId/tool-call runs the exact `app_tool_call` chain
 * (`performAppToolCall`: ui.tools allowlist → dispatchTool/callImportedTool)
 * over REST. Exercises the real REST layer via `startHttpServer`, same
 * pattern as workspaces-http-routes.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http"
import { brotliDecompressSync, gunzipSync } from "node:zlib"
import type { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"
import { workBoardApp, liveSessionApp, sessionChatApp } from "@agentproto/apps"

import { startHttpServer, type RuntimeHttpServerOptions } from "../http-server.js"
import { mintAppEmbedToken } from "../embed-tokens.js"
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
    vi.unstubAllEnvs()
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
      expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'self' vscode-webview:")
      expect(res.headers.get("x-frame-options")).toBeNull()
      const html = await res.text()
      expect(html).toContain("media-viewer-marker")
      // Bridge injected before the app's own script, pointing at ./tool-call.
      expect(html.indexOf('fetch("./tool-call"')).toBeGreaterThan(-1)
      expect(html.indexOf('fetch("./tool-call"')).toBeLessThan(html.indexOf("media-viewer-marker"))
    })
  })

  it("injects an https base URL when a reverse proxy forwards https", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${APP_ID}/ui`, {
        headers: { "x-forwarded-proto": "https, http" },
      })
      const expected = base.replace(/^http:/, "https:")
      expect(await res.text()).toContain(
        `window.__AGENTPROTO_BASEURL__=${JSON.stringify(expected)}`,
      )
    })
  })

  it("prefers AGENTPROTO_PUBLIC_HTTP_ORIGIN over request headers", async () => {
    vi.stubEnv("AGENTPROTO_PUBLIC_HTTP_ORIGIN", " https://apps.example.test/// ")
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${APP_ID}/ui`, {
        headers: { "x-forwarded-proto": "http" },
      })
      expect(await res.text()).toContain(
        'window.__AGENTPROTO_BASEURL__="https://apps.example.test"',
      )
    })
  })

  it("GET /apps/:appId/ui does not permit an arbitrary public origin to frame it", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${APP_ID}/ui`)
      const csp = res.headers.get("content-security-policy")
      expect(csp).not.toContain("*")
      expect(csp).not.toContain("https://evil.example")
    })
  })

  it("GET /apps/:appId/ui includes a configured extra frame-ancestor source", async () => {
    await withServer(
      async base => {
        const res = await fetch(`${base}/apps/${APP_ID}/ui`)
        const csp = res.headers.get("content-security-policy")
        expect(csp).toContain("https://panel.example")
        expect(csp).toContain("vscode-webview:")
      },
      { frameAncestors: ["https://panel.example"] },
    )
  })

  it("GET /apps/:appId/ui/ (trailing slash, e.g. a reload after the SPA router's rewrite) serves the same app", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${APP_ID}/ui/?session=sess_x`)
      expect(res.status).toBe(200)
      expect(await res.text()).toContain("media-viewer-marker")
    })
  })

  it("GET with a %2F-encoded appId serves the same app", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${encodeURIComponent(APP_ID)}/ui`)
      expect(res.status).toBe(200)
      expect(await res.text()).toContain("media-viewer-marker")
    })
  })

  it("GET with ?embed=1 drops the anti-framing headers for the daemon's own origin (iframe navigation)", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${APP_ID}/ui?session=sess_1&embed=1`, {
        headers: { "sec-fetch-dest": "iframe", origin: base },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get("x-frame-options")).toBeNull()
      expect(res.headers.get("content-security-policy")).toBeNull()
      expect(await res.text()).toContain("media-viewer-marker")
    })
  })

  it("GET with ?embed=1 drops the headers for a vscode-webview:// origin", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${APP_ID}/ui?embed=1`, {
        headers: { "sec-fetch-dest": "iframe", origin: "vscode-webview://webview-abc123" },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get("x-frame-options")).toBeNull()
      expect(res.headers.get("content-security-policy")).toBeNull()
    })
  })

  it("GET with ?embed=1 drops the headers for an app-declared csp.frameDomains origin", async () => {
    appRegistry.upsertApp({
      appId: APP_ID,
      dir,
      agents: [],
      workflows: [],
      unvalidatedAgentTools: [],
      ui: {
        path: uiPath,
        title: "Media Viewer",
        tools: ["directory_list", "file_info"],
        csp: { frameDomains: ["https://panel.example"] },
      },
    })
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${APP_ID}/ui?embed=1`, {
        headers: { "sec-fetch-dest": "iframe", origin: "https://panel.example" },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get("x-frame-options")).toBeNull()
      expect(res.headers.get("content-security-policy")).toBeNull()
    })
  })

  it("GET with ?embed=1 and NO Origin/Referer keeps the anti-framing headers (no-referrer refusal)", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${APP_ID}/ui?session=sess_1&embed=1`, {
        headers: { "sec-fetch-dest": "iframe" },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get("x-frame-options")).toBeNull()
      expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'self' vscode-webview:")
    })
  })

  it("GET with ?embed=1 and a non-iframe sec-fetch-dest keeps the default headers (top-level navigation)", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${APP_ID}/ui?embed=1`, {
        headers: { "sec-fetch-dest": "document", origin: base },
      })
      expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'self' vscode-webview:")
    })
  })

  it("GET with ?embed=1 from a non-embedder origin keeps the default headers (Referer-only fallback refused)", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${APP_ID}/ui?embed=1`, {
        headers: { "sec-fetch-dest": "iframe", referer: "http://evil.example/page" },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'self' vscode-webview:")
    })
  })

  it("GET with a cross-origin hostile embed is refused outright by guardBrowserOrigin", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${APP_ID}/ui?session=sess_1&embed=1`, {
        headers: { "sec-fetch-dest": "iframe", origin: "https://evil.com" },
      })
      expect(res.status).toBe(403)
    })
  })

  it("GET with a non-1 embed value keeps the default anti-framing headers", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${APP_ID}/ui?embed=0`)
      expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'self' vscode-webview:")
    })
  })

  it("GET with ?embed=1 and a valid per-boot embed token drops the headers with no Origin/Referer at all (Claude Desktop widget case)", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${APP_ID}/ui?session=sess_1&embed=1&et=${mintAppEmbedToken(APP_ID)}`, {
        headers: { "sec-fetch-dest": "iframe" },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get("x-frame-options")).toBeNull()
      expect(res.headers.get("content-security-policy")).toBeNull()
      expect(await res.text()).toContain("media-viewer-marker")
    })
  })

  it("GET with ?embed=1 and an INVALID embed token keeps the headers and names the refusal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await withServer(async base => {
        const res = await fetch(`${base}/apps/${APP_ID}/ui?session=sess_1&embed=1&et=stale-or-forged`, {
          headers: { "sec-fetch-dest": "iframe" },
        })
        expect(res.status).toBe(200)
        expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'self' vscode-webview:")
        const warned = warn.mock.calls.find(call => String(call[0]).includes("[app-ui] embed refused"))
        expect(warned).toBeDefined()
        expect(String(warned![0])).toContain('"embedToken":true')
      })
    } finally {
      warn.mockRestore()
    }
  })

  it("a valid embed token with a non-iframe sec-fetch-dest still keeps the headers", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${APP_ID}/ui?embed=1&et=${mintAppEmbedToken(APP_ID)}`, {
        headers: { "sec-fetch-dest": "document", origin: base },
      })
      expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'self' vscode-webview:")
    })
  })

  it("OPTIONS preflight for a token-bearing widget embed grants the PNA acknowledgement", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${APP_ID}/ui?embed=1&et=${mintAppEmbedToken(APP_ID)}`, {
        method: "OPTIONS",
        headers: {
          origin: "https://claude.ai",
          "access-control-request-private-network": "true",
        },
      })
      expect(res.status).toBe(204)
      expect(res.headers.get("access-control-allow-private-network")).toBe("true")
      expect(res.headers.get("access-control-allow-origin")).toBe("https://claude.ai")
    })
  })

  it("OPTIONS preflight WITHOUT a valid token keeps the untrusted-origin posture", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${APP_ID}/ui?embed=1&et=forged`, {
        method: "OPTIONS",
        headers: {
          origin: "https://claude.ai",
          "access-control-request-private-network": "true",
        },
      })
      expect(res.status).toBe(204)
      expect(res.headers.get("access-control-allow-private-network")).toBeNull()
      expect(res.headers.get("access-control-allow-origin")).toBe("*")
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

  it("GET /ui with a valid token and a non-iframe sec-fetch-dest (the blob pass-through FETCH) logs no embed refusal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await withServer(async base => {
        const res = await fetch(`${base}/apps/${APP_ID}/ui?embed=1&et=${mintAppEmbedToken(APP_ID)}`, {
          headers: { "sec-fetch-dest": "empty", origin: "null" },
        })
        expect(res.status).toBe(200)
        expect(await res.text()).toContain("media-viewer-marker")
        expect(warn.mock.calls.find(call => String(call[0]).includes("[app-ui] embed refused"))).toBeUndefined()
      })
    } finally {
      warn.mockRestore()
    }
  })

  // ── Blob-frame widget path: an opaque (`Origin: null`) blob: document
  // reaching the daemon with the per-boot embed token on every request.
  it("POST /apps/:appId/tool-call from a null Origin with a valid embed token dispatches", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${APP_ID}/tool-call?et=${mintAppEmbedToken(APP_ID)}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "null" },
        body: JSON.stringify({ tool: "directory_list", args: { path: "/tmp" } }),
      })
      expect(res.status).toBe(200)
      expect(dispatched).toEqual([{ name: "directory_list", args: { path: "/tmp" } }])
    })
  })

  it("POST /apps/:appId/tool-call from a null Origin with a FORGED token still 403s", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${APP_ID}/tool-call?et=forged`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "null" },
        body: JSON.stringify({ tool: "directory_list" }),
      })
      expect(res.status).toBe(403)
      expect(((await res.json()) as { error: string }).error).toBe("forbidden_origin")
      expect(dispatched).toEqual([])
    })
  })

  it("POST /mcp from a null Origin passes the origin gate with a valid token and 403s with a forged one", async () => {
    await withServer(async base => {
      const call = (et: string) =>
        fetch(`${base}/mcp?et=${et}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            origin: "null",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        })
      const ok = await call(mintAppEmbedToken(APP_ID))
      expect(ok.status).toBe(200)
      const forged = await call("forged")
      expect(forged.status).toBe(403)
      expect(((await forged.json()) as { error: string }).error).toBe("mcp_forbidden_origin")
    })
  })

  it("mutating /sessions-class routes (checkSessionsToken) accept a valid embed token from a null Origin", async () => {
    await withServer(
      async base => {
        // /files/upload shares the mutating-/sessions gate; with the gate
        // passed it 400s on the missing cwd/name, never 401.
        const ok = await fetch(`${base}/files/upload?et=${mintAppEmbedToken(APP_ID)}`, {
          method: "POST",
          headers: { origin: "null" },
          body: "x",
        })
        expect(ok.status).toBe(400)
        const forged = await fetch(`${base}/files/upload?et=forged`, {
          method: "POST",
          headers: { origin: "null" },
          body: "x",
        })
        expect(forged.status).toBe(401)
      },
      { token: "per-boot-sessions-secret" },
    )
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

/**
 * Builtin-panel fallback — `resolveBuiltinPanelUi` (builtin-apps.ts) lets
 * `GET /apps/:appId/ui` / `POST /apps/:appId/tool-call` serve a builtin
 * panel (never persisted to `AppRegistry`, so `appRegistry.getApp` always
 * misses for one) the same way they already serve an installed app's.
 * `appRegistry` here is deliberately empty — the point is that the FALLBACK
 * carries the whole route without any installed-app record at all.
 */
describe("standalone app UI host — builtin panel fallback", () => {
  let appRegistry: AppRegistry
  let dispatched: Array<{ name: string; args: Record<string, unknown> }>

  beforeEach(() => {
    appRegistry = createAppRegistry()
    dispatched = []
  })

  async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
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
    })
    try {
      await fn(`http://127.0.0.1:${port}`)
    } finally {
      await http.stop()
    }
  }

  it("GET serves the work-board builtin's html with the REST bridge injected", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${encodeURIComponent(workBoardApp.id!)}/ui`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/html")
      const html = await res.text()
      expect(html).toContain("agentproto work board")
      expect(html.indexOf('fetch("./tool-call"')).toBeGreaterThan(-1)
    })
  })

  it("GET re-bakes live-session's httpBaseUrl to the REQUESTING daemon's real origin, not its static default", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${encodeURIComponent(liveSessionApp.id!)}/ui`)
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain(`"httpBaseUrl":"${base}"`)
      expect(html).not.toContain("127.0.0.1:18790")
    })
  })

  it("GET 404s for an appId that is neither installed nor a builtin", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/@nope/nothing/ui`)
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error: string }
      expect(body.error).toContain("not installed")
    })
  })

  it("GET 404s for the session-chat widget — it has no standalone content of its own", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${encodeURIComponent(sessionChatApp.id!)}/ui`)
      expect(res.status).toBe(404)
    })
  })

  it("POST dispatches a tool the builtin's OWN ui.tools declares (task_list, work-board)", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${encodeURIComponent(workBoardApp.id!)}/tool-call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: "task_list", args: { full: true } }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { content: Array<{ text: string }>; isError?: boolean }
      expect(body.isError).toBeUndefined()
      expect(JSON.parse(body.content[0]!.text)).toBe("dispatched:task_list")
      expect(dispatched).toEqual([{ name: "task_list", args: { full: true } }])
    })
  })

  it("POST refuses a tool NOT in the builtin's declared ui.tools allowlist — the security-critical case", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${encodeURIComponent(workBoardApp.id!)}/tool-call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: "command_execute", args: { command: "rm -rf /" } }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { content: Array<{ text: string }>; isError?: boolean }
      expect(body.isError).toBe(true)
      expect(body.content[0]!.text).toContain("allowlist")
      // Never reached dispatchTool — refused before dispatch, not after.
      expect(dispatched).toEqual([])
    })
  })

  it("POST 404-shaped-refuses for an appId that is neither installed nor a builtin", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/@nope/nothing/tool-call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: "task_list" }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { content: Array<{ text: string }>; isError?: boolean }
      expect(body.isError).toBe(true)
      expect(body.content[0]!.text).toContain("not installed")
      expect(dispatched).toEqual([])
    })
  })

  it("blocks a non-allowlisted browser origin's drive-by on the builtin fallback too", async () => {
    await withServer(async base => {
      const ui = await fetch(`${base}/apps/${encodeURIComponent(workBoardApp.id!)}/ui`, {
        headers: { origin: "http://evil.example" },
      })
      expect(ui.status).toBe(403)
      const call = await fetch(`${base}/apps/${encodeURIComponent(workBoardApp.id!)}/tool-call`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://evil.example" },
        body: JSON.stringify({ tool: "task_list" }),
      })
      expect(call.status).toBe(403)
      expect(dispatched).toEqual([])
    })
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

/**
 * Shell delivery — `GET /apps/:appId/ui` and `GET /apps/:appId/ui/assets/:file`
 * negotiate `accept-encoding` (br, then gzip), validate with a strong etag
 * (304 on `if-none-match`), and the assets route serves a flat, validated
 * file name from the ui dir's `assets/` behind the page's exact gate. Raw
 * `node:http` requests here, not `fetch`: fetch transparently decodes bodies
 * and normalizes `..` out of URLs, both of which would hide what's tested.
 */
describe("standalone app UI host — shell delivery", () => {
  const SHELL_APP_ID = "@agentproto/shell-app"
  const BEARER = "shell-bearer-secret"
  const BIG_SCRIPT = `<script type="module">${"console.log('shell-delivery-padding');\n".repeat(400)}</script>`
  let dir: string
  let uiPath: string
  let appRegistry: AppRegistry

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentproto-app-ui-shell-"))
    uiPath = join(dir, "index.html")
    await writeFile(uiPath, `<!doctype html><html><head></head><body>shell-marker${BIG_SCRIPT}</body></html>`, "utf8")
    await mkdir(join(dir, "assets"))
    await writeFile(join(dir, "assets", "index-abc123.js"), `export const x = "asset-marker";\n`.repeat(200), "utf8")
    await writeFile(join(dir, "assets", "font-abc123.woff2"), Buffer.from([0x77, 0x4f, 0x46, 0x32, 1, 2, 3]))
    await writeFile(join(dir, "secret.txt"), "outside-assets", "utf8")
    appRegistry = createAppRegistry()
    appRegistry.upsertApp({
      appId: SHELL_APP_ID,
      dir,
      agents: [],
      workflows: [],
      unvalidatedAgentTools: [],
      ui: { path: uiPath, title: "Shell App" },
    })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function withServer(
    fn: (port: number) => Promise<void>,
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
      appToolCallDeps: { dispatchTool: async () => "ok" },
      ...extra,
    })
    try {
      await fn(port)
    } finally {
      await http.stop()
    }
  }

  const page = `/apps/${SHELL_APP_ID}/ui`
  const asset = (file: string) => `/apps/${SHELL_APP_ID}/ui/assets/${file}`

  it("page: br preferred, gzip next, identity otherwise — with vary: accept-encoding", async () => {
    await withServer(async port => {
      const br = await rawGet(port, page, { "accept-encoding": "gzip, deflate, br" })
      expect(br.status).toBe(200)
      expect(br.headers["content-encoding"]).toBe("br")
      expect(br.headers.vary).toBe("Origin, accept-encoding")
      expect(Number(br.headers["content-length"])).toBe(br.body.length)
      const html = brotliDecompressSync(br.body).toString("utf8")
      expect(html).toContain("shell-marker")
      expect(html).toContain('fetch("./tool-call"')
      expect(br.body.length).toBeLessThan(html.length / 4)

      const gz = await rawGet(port, page, { "accept-encoding": "gzip, br;q=0" })
      expect(gz.headers["content-encoding"]).toBe("gzip")
      expect(gunzipSync(gz.body).toString("utf8")).toBe(html)

      const plain = await rawGet(port, page, {})
      expect(plain.headers["content-encoding"]).toBeUndefined()
      expect(plain.headers.vary).toBe("Origin, accept-encoding")
      expect(plain.body.toString("utf8")).toBe(html)
    })
  })

  it("page: no-cache + strong etag, 304 on if-none-match with the frame headers intact, new etag after a change", async () => {
    await withServer(async port => {
      const first = await rawGet(port, page, { "accept-encoding": "br" })
      expect(first.headers["cache-control"]).toBe("no-cache")
      const etag = first.headers.etag as string
      expect(etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/)
      expect(first.headers["content-security-policy"]).toBe("frame-ancestors 'self' vscode-webview:")

      const again = await rawGet(port, page, { "accept-encoding": "br", "if-none-match": etag })
      expect(again.status).toBe(304)
      expect(again.body.length).toBe(0)
      expect(again.headers.etag).toBe(etag)
      expect(again.headers["cache-control"]).toBe("no-cache")
      expect(again.headers["content-security-policy"]).toBe("frame-ancestors 'self' vscode-webview:")

      // Encoding never changes the entity tag: identity revalidates too.
      expect((await rawGet(port, page, { "if-none-match": etag })).status).toBe(304)
      expect((await rawGet(port, page, { "if-none-match": '"stale"' })).status).toBe(200)

      await writeFile(uiPath, "<!doctype html><html><head></head><body>shell-marker-v2</body></html>", "utf8")
      const changed = await rawGet(port, page, { "if-none-match": etag })
      expect(changed.status).toBe(200)
      expect(changed.headers.etag).not.toBe(etag)
      expect(changed.body.toString("utf8")).toContain("shell-marker-v2")
    })
  })

  it("page: a granted ?embed=1 carries a different etag, so it never revalidates a framed-headers copy", async () => {
    await withServer(async port => {
      const plain = await rawGet(port, page, {})
      const embed = await rawGet(port, `${page}?embed=1`, {
        "sec-fetch-dest": "iframe",
        origin: "vscode-webview://abc123",
      })
      expect(embed.status).toBe(200)
      expect(embed.headers["content-security-policy"]).toBeUndefined()
      expect(embed.headers.etag).not.toBe(plain.headers.etag)
      const replay = await rawGet(port, `${page}?embed=1`, {
        "sec-fetch-dest": "iframe",
        origin: "vscode-webview://abc123",
        "if-none-match": plain.headers.etag as string,
      })
      expect(replay.status).toBe(200)
    })
  })

  it("assets: serves a hashed chunk with its content type, immutable caching, compression and 304", async () => {
    await withServer(async port => {
      const js = await rawGet(port, asset("index-abc123.js"), { "accept-encoding": "br" })
      expect(js.status).toBe(200)
      expect(js.headers["content-type"]).toBe("text/javascript; charset=utf-8")
      expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable")
      expect(js.headers["content-encoding"]).toBe("br")
      expect(js.headers.vary).toBe("Origin, accept-encoding")
      expect(brotliDecompressSync(js.body).toString("utf8")).toContain("asset-marker")
      const revalidated = await rawGet(port, asset("index-abc123.js"), {
        "if-none-match": js.headers.etag as string,
      })
      expect(revalidated.status).toBe(304)

      // Already-compressed formats go out as-is.
      const font = await rawGet(port, asset("font-abc123.woff2"), { "accept-encoding": "br, gzip" })
      expect(font.status).toBe(200)
      expect(font.headers["content-type"]).toBe("font/woff2")
      expect(font.headers["content-encoding"]).toBeUndefined()
      expect([...font.body]).toEqual([0x77, 0x4f, 0x46, 0x32, 1, 2, 3])

      expect((await rawGet(port, asset("missing-abc.js"), {})).status).toBe(404)
      // Encoded appId spelling routes the same.
      expect((await rawGet(port, `/apps/${encodeURIComponent(SHELL_APP_ID)}/ui/assets/index-abc123.js`, {})).status).toBe(200)
    })
  })

  it("assets: traversal, separators, dotfiles and symlink escapes are all 404s", async () => {
    await symlink(join(dir, "secret.txt"), join(dir, "assets", "escape.js"))
    await withServer(async port => {
      for (const bad of [
        "..",
        ".",
        ".hidden",
        "..%2Fsecret.txt",
        "..%2F..%2Findex.html",
        "a%2Fb.js",
        "%2e%2e",
        "",
        "escape.js",
      ]) {
        const res = await rawGet(port, asset(bad), {})
        expect(res.status, bad).toBe(404)
        expect(res.body.toString("utf8"), bad).not.toContain("outside-assets")
      }
      const nested = await rawGet(port, `/apps/${SHELL_APP_ID}/ui/assets/../../secret.txt`, {})
      expect(nested.status).toBe(404)
      expect(nested.body.toString("utf8")).not.toContain("outside-assets")
    })
  })

  it("assets: gated exactly like the page — hostile origin 403s both, a trusted embedder passes both", async () => {
    await withServer(async port => {
      for (const path of [page, asset("index-abc123.js")]) {
        expect((await rawGet(port, path, { origin: "http://evil.example" })).status, path).toBe(403)
        expect((await rawGet(port, path, { origin: "vscode-webview://abc123" })).status, path).toBe(200)
        const token = mintAppEmbedToken(SHELL_APP_ID)
        expect((await rawGet(port, `${path}?et=${token}`, { origin: "null" })).status, path).toBe(200)
      }
    })
  })

  it("assets: share the page's tunnel static-shell exemption, and only for a valid file name", async () => {
    await withServer(
      async port => {
        const tunnel = { "x-forwarded-for": "203.0.113.7" }
        expect((await rawGet(port, page, tunnel)).status).toBe(200)
        expect((await rawGet(port, asset("index-abc123.js"), tunnel)).status).toBe(200)
        // A malformed asset path is not the shell: the bearer gate applies.
        expect((await rawGet(port, asset(".hidden"), tunnel)).status).toBe(401)
        expect((await rawGet(port, asset("a%2Fb.js"), tunnel)).status).toBe(401)
        // The APIs under the shell stay gated.
        expect((await rawGet(port, `/apps/${SHELL_APP_ID}/external-blob?root=/`, tunnel)).status).toBe(401)
      },
      { auth: { mode: "bearer", token: BEARER } },
    )
  })

  it("assets: builtin panels and unknown apps have none", async () => {
    await withServer(async port => {
      expect((await rawGet(port, `/apps/${encodeURIComponent(workBoardApp.id!)}/ui/assets/index-abc123.js`, {})).status).toBe(404)
      expect((await rawGet(port, `/apps/@nope/nope/ui/assets/index-abc123.js`, {})).status).toBe(404)
    })
  })
})

function rawGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, res => {
      const chunks: Buffer[] = []
      res.on("data", (c: Buffer) => chunks.push(c))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on("error", reject)
    })
    req.on("error", reject)
    req.end()
  })
}
