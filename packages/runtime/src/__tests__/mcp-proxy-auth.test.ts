/**
 * The `/mcps/*` mutating routes invoke imported MCP servers (which may
 * hold third-party credentials) and edit ~/.agentproto/imported-mcps.json,
 * but they sat outside the per-boot token gate that every other mutating
 * route (`/sessions/*`, `/workspaces`, `/adapters/:slug/install`, …) uses
 * via `checkSessionsToken` — anyone who could reach the daemon port could
 * call imported tools with no bearer. This locks the gate on:
 *
 *   - POST /mcps/proxy/call   (invoke an imported tool)
 *   - POST /mcps/imports      (register an import)
 *   - DELETE /mcps/imports/:id (remove an import)
 *
 * while the read-only GETs (/mcps/imports, /mcps/discovered,
 * /mcps/proxy/status, /mcps/proxy/tools/:alias) stay ungated, matching
 * the file's stated precedent for read-only routes.
 */

import { describe, it, expect, vi } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createSessionsRegistry } from "../sessions.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import type { McpProxyRegistry } from "../mcp-proxy.js"

const TOKEN = "test-secret-token"

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
  return { start() {}, stop() {}, async fireNow() {} }
}

async function mcpServerFactory() {
  return (await createMcpServer({ specs: [], name: "main", version: "0" })).server
}

async function startWithProxy(
  port: number,
  token: string | undefined,
  callTool: McpProxyRegistry["callTool"],
): Promise<{ stop(): Promise<void> }> {
  const mcpProxy = { callTool } as unknown as McpProxyRegistry
  return startHttpServer({
    port,
    ...(token ? { token } : {}),
    auth: { mode: token ? "bearer" : "none" },
    mcpServerFactory,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    sessions: createSessionsRegistry({ persist: false }),
    mcpProxy,
    meta: { workspace: process.cwd(), registered: [] },
  })
}

function proxyCallUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcps/proxy/call`
}

async function postProxyCall(
  port: number,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(proxyCallUrl(port), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ alias: "chrome", toolName: "navigate", args: {} }),
  })
}

describe("mcps proxy call — bearer gate", () => {
  it("rejects a tokenless call with 401 and does NOT invoke the imported tool", async () => {
    const port = await freePort()
    const callTool = vi.fn(
      async () => ({ ok: true, result: {} }) as Awaited<ReturnType<McpProxyRegistry["callTool"]>>,
    )
    const http = await startWithProxy(port, TOKEN, callTool)
    try {
      const res = await postProxyCall(port)
      expect(res.status).toBe(401)
      const body = (await res.json()) as { error?: string }
      expect(body.error).toBe("sessions_unauthorized")
      expect(callTool).not.toHaveBeenCalled()
    } finally {
      await http.stop()
    }
  })

  it("rejects a WRONG token with 401 and does NOT invoke the imported tool", async () => {
    const port = await freePort()
    const callTool = vi.fn(
      async () => ({ ok: true, result: {} }) as Awaited<ReturnType<McpProxyRegistry["callTool"]>>,
    )
    const http = await startWithProxy(port, TOKEN, callTool)
    try {
      const res = await postProxyCall(port, {
        authorization: "Bearer not-the-token",
      })
      expect(res.status).toBe(401)
      expect(callTool).not.toHaveBeenCalled()
    } finally {
      await http.stop()
    }
  })

  it("lets a call WITH the correct bearer reach the proxy (200, tool invoked)", async () => {
    const port = await freePort()
    const callTool = vi.fn(
      async () =>
        ({ ok: true, result: { ok: true } }) as Awaited<ReturnType<McpProxyRegistry["callTool"]>>,
    )
    const http = await startWithProxy(port, TOKEN, callTool)
    try {
      const res = await postProxyCall(port, {
        authorization: `Bearer ${TOKEN}`,
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok?: boolean }
      expect(body.ok).toBe(true)
      expect(callTool).toHaveBeenCalledTimes(1)
      expect(callTool).toHaveBeenCalledWith("chrome", "navigate", {})
    } finally {
      await http.stop()
    }
  })

  it("keeps the route callable without a token (auth mode none, local dev)", async () => {
    const port = await freePort()
    const callTool = vi.fn(
      async () =>
        ({ ok: true, result: {} }) as Awaited<ReturnType<McpProxyRegistry["callTool"]>>,
    )
    const http = await startWithProxy(port, undefined, callTool)
    try {
      const res = await postProxyCall(port)
      expect(res.status).toBe(200)
      expect(callTool).toHaveBeenCalledTimes(1)
    } finally {
      await http.stop()
    }
  })
})

describe("mcps imports — bearer gate on the mutating pair", () => {
  it("401s a tokenless POST /mcps/imports without touching imports state", async () => {
    const port = await freePort()
    const http = await startWithProxy(
      port,
      TOKEN,
      async () => ({ ok: true, result: {} }) as Awaited<ReturnType<McpProxyRegistry["callTool"]>>,
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcps/imports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceMcpId: "some:mcp" }),
      })
      expect(res.status).toBe(401)
      const body = (await res.json()) as { error?: string }
      expect(body.error).toBe("sessions_unauthorized")
    } finally {
      await http.stop()
    }
  })

  it("401s a tokenless DELETE /mcps/imports/:id", async () => {
    const port = await freePort()
    const http = await startWithProxy(
      port,
      TOKEN,
      async () => ({ ok: true, result: {} }) as Awaited<ReturnType<McpProxyRegistry["callTool"]>>,
    )
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/mcps/imports/${encodeURIComponent("some:mcp")}`,
        { method: "DELETE" },
      )
      expect(res.status).toBe(401)
      const body = (await res.json()) as { error?: string }
      expect(body.error).toBe("sessions_unauthorized")
    } finally {
      await http.stop()
    }
  })

  it("keeps the read-only GETs ungated (imports list, proxy status)", async () => {
    const port = await freePort()
    const callTool = vi.fn(
      async () => ({ ok: true, result: {} }) as Awaited<ReturnType<McpProxyRegistry["callTool"]>>,
    )
    const mcpProxy = {
      callTool,
      listAliases: async () => [],
    } as unknown as McpProxyRegistry
    const http = await startHttpServer({
      port,
      token: TOKEN,
      auth: { mode: "bearer" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: createSessionsRegistry({ persist: false }),
      mcpProxy,
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const imports = await fetch(`http://127.0.0.1:${port}/mcps/imports`)
      expect(imports.status).toBe(200)
      const status = await fetch(`http://127.0.0.1:${port}/mcps/proxy/status`)
      expect(status.status).toBe(200)
    } finally {
      await http.stop()
    }
  })
})
