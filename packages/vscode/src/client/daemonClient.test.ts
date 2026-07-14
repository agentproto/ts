import { createServer, type Server } from "node:http"
import { AddressInfo } from "node:net"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { DaemonClient } from "./daemonClient.js"

/** Spin a mock daemon on an ephemeral port. Returns base URL + request log. */
function mockDaemon(handler: (req: {
  method: string
  url: string
  body: unknown
  headers: Record<string, string | string[] | undefined>
}) => { status: number; body?: unknown }): {
  url: string
  server: Server
  requests: Array<{ method: string; url: string; body: unknown; headers: Record<string, string | string[] | undefined> }>
} {
  const requests: Array<{ method: string; url: string; body: unknown; headers: Record<string, string | string[] | undefined> }> = []
  const server = createServer((req, res) => {
    let chunks = ""
    req.on("data", (c: Buffer) => (chunks += c.toString("utf8")))
    req.on("end", () => {
      const body = chunks ? JSON.parse(chunks) : undefined
      const captured = { method: req.method ?? "GET", url: req.url ?? "/", body, headers: { ...req.headers } }
      requests.push(captured)
      const { status, body: resp } = handler(captured)
      res.writeHead(status, { "content-type": "application/json" })
      res.end(resp === undefined ? "" : JSON.stringify(resp))
    })
  })
  server.listen(0)
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, server, requests }
}

describe("DaemonClient — URL + auth header mapping", () => {
  let daemon: ReturnType<typeof mockDaemon>

  beforeEach(() => {
    daemon = mockDaemon(req => {
      // Echo back the request so tests can assert auth + path mapping.
      if (req.url === "/health") return { status: 200, body: { status: "ok", workspace: "/ws", registered: [] } }
      if (req.url === "/sessions" && req.method === "GET") return { status: 200, body: { sessions: [{ id: "s1", kind: "agent-cli", status: "running", command: "x", pid: 1, startedAt: "t", workspaceSlug: "ws" }] } }
      if (req.url === "/permissions" && req.method === "GET") return { status: 200, body: { permissions: [] } }
      if (req.url?.startsWith("/permissions?sessionId=") && req.method === "GET") return { status: 200, body: { permissions: [] } }
      if (req.url?.startsWith("/sessions/s1") && req.method === "GET") return { status: 200, body: { id: "s1", kind: "agent-cli", status: "running", command: "x", pid: 1, startedAt: "t", workspaceSlug: "ws" } }
      if (req.url === "/sessions/agent" && req.method === "POST") return { status: 201, body: { id: "s2", kind: "agent-cli", status: "starting", command: "c", pid: 2, startedAt: "t", workspaceSlug: "ws" } }
      if (req.url?.startsWith("/sessions/s1/kill") && req.method === "POST") return { status: 200, body: { ok: true, sessionId: "s1" } }
      if (req.url?.startsWith("/sessions/s1/prompt") && req.method === "POST") return { status: 200, body: { ok: true } }
      if (req.url === "/mcp" && req.method === "POST") {
        const rpc = req.body as { method: string; params: { name: string; arguments: Record<string, unknown> } }
        if (rpc.method === "tools/call" && rpc.params.name === "adapter_list") {
          return { status: 200, body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ adapters: [{ slug: "claude-code" }] }) }] } } }
        }
        if (rpc.method === "tools/call" && rpc.params.name === "session_events_poll") {
          return { status: 200, body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ events: [], nextCursor: 7 }) }] } } }
        }
        return { status: 200, body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "{}" }] } } }
      }
      return { status: 404, body: { error: "not_found" } }
    })
  })

  afterEach(() => daemon.server.close())

  function client(tokenPath = ""): DaemonClient {
    return new DaemonClient({ daemonUrl: daemon.url, tokenPath, pollIntervalMs: 5000 })
  }

  it("strips a trailing slash from the daemon URL", () => {
    const c = new DaemonClient({ daemonUrl: `${daemon.url}/`, tokenPath: "", pollIntervalMs: 5000 })
    expect(c.url).toBe(daemon.url)
  })

  it("GET /health returns the typed health object", async () => {
    const health = await client().health()
    expect(health.status).toBe("ok")
    expect(health.workspace).toBe("/ws")
  })

  it("GET /sessions unwraps the { sessions } envelope", async () => {
    const sessions = await client().listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.id).toBe("s1")
  })

  it("GET /sessions/:id returns a single descriptor", async () => {
    const s = await client().getSession("s1")
    expect(s.id).toBe("s1")
  })

  it("POST /sessions/agent sends the spawn body and returns 201 descriptor", async () => {
    const s = await client().spawnAgent({ adapter: "claude-code", prompt: "hi" })
    expect(s.id).toBe("s2")
    const last = daemon.requests[daemon.requests.length - 1]!
    expect(last.method).toBe("POST")
    expect(last.url).toBe("/sessions/agent")
    expect(last.body).toMatchObject({ adapter: "claude-code", prompt: "hi" })
  })

  it("POST /sessions/:id/prompt?wait=false maps to fire-and-forget", async () => {
    await client().prompt("s1", "hello", { wait: false })
    const last = daemon.requests[daemon.requests.length - 1]!
    expect(last.url).toBe("/sessions/s1/prompt?wait=false")
    expect(last.body).toMatchObject({ prompt: "hello" })
  })

  it("POST /sessions/:id/prompt?wait=true (default) maps to blocking", async () => {
    await client().prompt("s1", "hello")
    const last = daemon.requests[daemon.requests.length - 1]!
    expect(last.url).toBe("/sessions/s1/prompt?wait=true")
  })

  it("prompt interrupt:true is sent in the body", async () => {
    await client().prompt("s1", "go", { interrupt: true })
    const last = daemon.requests[daemon.requests.length - 1]!
    expect(last.body).toMatchObject({ prompt: "go", interrupt: true })
  })

  it("POST /sessions/:id/kill returns { ok, sessionId }", async () => {
    const res = await client().kill("s1")
    expect(res).toEqual({ ok: true, sessionId: "s1" })
  })

  it("throws on a non-2xx response", async () => {
    await expect(client().getSession("ghost")).rejects.toThrow(/404/)
  })

  it("listPermissions() unwraps the { permissions } envelope", async () => {
    const perms = await client().listPermissions()
    expect(perms).toEqual([])
  })

  it("listPermissions(sessionId) appends the sessionId query", async () => {
    await client().listPermissions("s1")
    const last = daemon.requests[daemon.requests.length - 1]!
    expect(last.url).toBe("/permissions?sessionId=s1")
  })

  it("respondPermission posts the decision body to /permissions/:id", async () => {
    // The mock returns 404 for unknown permission ids — patch it inline.
    daemon.server.removeAllListeners("request")
    daemon.server.on("request", (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, id: "p1", sessionId: "s1", decision: "approve" }))
    })
    const res = await client().respondPermission("p1", { decision: "approve", scope: "always" })
    expect(res.ok).toBe(true)
    expect(res.decision).toBe("approve")
  })

  it("mcpCall posts a JSON-RPC tools/call envelope to /mcp", async () => {
    const result = await client().mcpCall<{ adapters: Array<{ slug: string }> }>("adapter_list")
    expect(result.adapters?.[0]?.slug).toBe("claude-code")
    const last = daemon.requests[daemon.requests.length - 1]!
    expect(last.url).toBe("/mcp")
    expect(last.body).toMatchObject({ jsonrpc: "2.0", method: "tools/call", params: { name: "adapter_list" } })
  })

  it("sessionEventsPoll unwraps { events, nextCursor }", async () => {
    const result = await client().sessionEventsPoll(0)
    expect(result.nextCursor).toBe(7)
    expect(result.events).toEqual([])
  })

  it("listAdapters() routes through mcpCall adapter_list", async () => {
    const adapters = await client().listAdapters()
    expect(adapters[0]?.slug).toBe("claude-code")
  })

  it("loopback (no token file): requests are sent without an Authorization header", async () => {
    await client().health()
    const last = daemon.requests[daemon.requests.length - 1]!
    expect(last.headers.authorization).toBeUndefined()
  })

  it("tokenPath override: reads the token and sends it as Bearer", async () => {
    const { writeFile, mkdir, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = await mkdtemp(join(tmpdir(), "agentproto-vscode-test-"))
    const tokenFile = join(dir, "runtime.json")
    await writeFile(tokenFile, JSON.stringify({ token: "secret-token-123" }), "utf8")
    try {
      await client(tokenFile).health()
      const last = daemon.requests[daemon.requests.length - 1]!
      expect(last.headers.authorization).toBe("Bearer secret-token-123")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("mcpCall throws on an MCP-level error envelope", async () => {
    daemon.server.removeAllListeners("request")
    daemon.server.on("request", (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad args" } }))
    })
    await expect(client().mcpCall("adapter_list")).rejects.toThrow(/bad args/)
  })
})

// Inline mkdtemp to avoid a top-level import the linter would reorder.
async function mkdtemp(prefix: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises")
  const { join } = await import("node:path")
  return mkdtemp(prefix)
}
