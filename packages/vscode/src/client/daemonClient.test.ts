import { createServer, type Server } from "node:http"
import { AddressInfo } from "node:net"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { DaemonClient, NoTranscriptError } from "./daemonClient.js"

/**
 * Spin a mock daemon on an ephemeral port. Returns base URL + request log.
 *
 * Binds explicitly to 127.0.0.1 — the SAME host the client dials — and awaits
 * the `listening` event before reading the port. `listen(0)` without a host
 * binds to `::` (all IPv6 interfaces); on a dual-stack / v6only host the
 * OS-assigned port need not be free on the IPv4 loopback, so the client's
 * `http://127.0.0.1:<port>` request could land on an unrelated real service
 * (e.g. an auth-enabled agentproto daemon → 401 on a wrong bearer). Binding to
 * 127.0.0.1 guarantees the client and the mock share the exact same socket.
 */
async function mockDaemon(handler: (req: {
  method: string
  url: string
  body: unknown
  headers: Record<string, string | string[] | undefined>
}) => { status: number; body?: unknown }): Promise<{
  url: string
  server: Server
  requests: Array<{ method: string; url: string; body: unknown; headers: Record<string, string | string[] | undefined> }>
}> {
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
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, server, requests }
}

describe("DaemonClient — URL + auth header mapping", () => {
  let daemon: Awaited<ReturnType<typeof mockDaemon>>

  beforeEach(async () => {
    daemon = await mockDaemon(req => {
      // Echo back the request so tests can assert auth + path mapping.
      if (req.url === "/health") return { status: 200, body: { status: "ok", workspace: "/ws", registered: [] } }
      if (req.url === "/sessions" && req.method === "GET") return { status: 200, body: { sessions: [{ id: "s1", kind: "agent-cli", status: "running", command: "x", pid: 1, startedAt: "t", workspaceSlug: "ws" }] } }
      if (req.url === "/permissions" && req.method === "GET") return { status: 200, body: { permissions: [] } }
      if (req.url?.startsWith("/permissions?sessionId=") && req.method === "GET") return { status: 200, body: { permissions: [] } }
      if (req.url?.startsWith("/sessions/s1/events") && req.method === "GET") {
        return {
          status: 200,
          body: {
            sessionId: "s1",
            events: [
              { seq: 1, ts: "t", kind: "user-prompt", text: "hi" },
              { seq: 2, ts: "t", kind: "turn-end", reason: "completed" },
            ],
            nextSeq: 2,
            complete: true,
          },
        }
      }
      if (req.url?.startsWith("/sessions/terminal1/events") && req.method === "GET") {
        return { status: 404, body: { error: "no_transcript" } }
      }
      if (req.url?.startsWith("/sessions/s1") && req.method === "GET") return { status: 200, body: { id: "s1", kind: "agent-cli", status: "running", command: "x", pid: 1, startedAt: "t", workspaceSlug: "ws" } }
      if (req.url === "/sessions/agent" && req.method === "POST") return { status: 201, body: { id: "s2", kind: "agent-cli", status: "starting", command: "c", pid: 2, startedAt: "t", workspaceSlug: "ws" } }
      if (req.url?.startsWith("/sessions/s1/kill") && req.method === "POST") return { status: 200, body: { ok: true, sessionId: "s1" } }
      if (req.url?.startsWith("/sessions/s1/interrupt") && req.method === "POST") return { status: 200, body: { ok: true, id: "s1", wasBusy: true } }
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

  afterEach(async () => {
    await new Promise<void>(resolve => daemon.server.close(() => resolve()))
  })

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

  it("POST /sessions/:id/interrupt returns { ok, id, wasBusy }", async () => {
    const res = await client().interrupt("s1")
    expect(res).toEqual({ ok: true, id: "s1", wasBusy: true })
    const last = daemon.requests[daemon.requests.length - 1]!
    expect(last.method).toBe("POST")
    expect(last.url).toBe("/sessions/s1/interrupt")
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

  it("getSessionEvents returns the typed events page", async () => {
    const page = await client().getSessionEvents("s1")
    expect(page.sessionId).toBe("s1")
    expect(page.events.map(e => e.kind)).toEqual(["user-prompt", "turn-end"])
    expect(page.nextSeq).toBe(2)
    expect(page.complete).toBe(true)
    const last = daemon.requests[daemon.requests.length - 1]!
    expect(last.url).toBe("/sessions/s1/events")
  })

  it("getSessionEvents forwards since/limit as query params", async () => {
    await client().getSessionEvents("s1", { since: 3, limit: 50 })
    const last = daemon.requests[daemon.requests.length - 1]!
    expect(last.url).toBe("/sessions/s1/events?since=3&limit=50")
  })

  it("getSessionEvents throws NoTranscriptError on a 404 no_transcript", async () => {
    await expect(client().getSessionEvents("terminal1")).rejects.toBeInstanceOf(NoTranscriptError)
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

/**
 * A raw-body mock daemon for the file-upload route: unlike `mockDaemon` above
 * it does NOT JSON-parse the body (the upload body is binary), it captures the
 * exact bytes so a test can prove they arrive untouched. `respond` lets a test
 * force a non-2xx (e.g. the route's 413) to exercise the error path.
 */
async function uploadMock(
  respond: (req: { url: string; method: string; headers: Record<string, string | string[] | undefined> }) => {
    status: number
    body?: unknown
  } = () => ({ status: 200 }),
): Promise<{
  url: string
  server: Server
  requests: Array<{ url: string; method: string; body: Buffer; headers: Record<string, string | string[] | undefined> }>
}> {
  const requests: Array<{ url: string; method: string; body: Buffer; headers: Record<string, string | string[] | undefined> }> = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const body = Buffer.concat(chunks)
      const captured = { url: req.url ?? "/", method: req.method ?? "GET", body, headers: { ...req.headers } }
      requests.push(captured)
      const { status, body: resp } = respond(captured)
      res.writeHead(status, { "content-type": "application/json" })
      res.end(status === 200 ? JSON.stringify(resp ?? { path: "/home/.agentproto/.agentproto-attachments/x.png", bytes: body.length }) : JSON.stringify(resp ?? { error: "file_too_large" }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, server, requests }
}

describe("DaemonClient.uploadFile — raw binary transport", () => {
  let daemon: Awaited<ReturnType<typeof uploadMock>>

  afterEach(async () => {
    if (daemon) await new Promise<void>(resolve => daemon.server.close(() => resolve()))
  })

  function client(): DaemonClient {
    return new DaemonClient({ daemonUrl: daemon.url, tokenPath: "", pollIntervalMs: 5000 })
  }

  it("POSTs the raw bytes and encodes cwd + name into the query string", async () => {
    daemon = await uploadMock(() => ({ status: 200, body: { path: "/home/.agentproto/.agentproto-attachments/paste.png", bytes: 3 } }))
    const res = await client().uploadFile("/home/.agentproto", "paste 1.png", new Uint8Array([1, 2, 3]), "image/png")
    expect(res).toEqual({ path: "/home/.agentproto/.agentproto-attachments/paste.png", bytes: 3 })
    const last = daemon.requests[daemon.requests.length - 1]!
    expect(last.method).toBe("POST")
    // A space in the name must be percent-encoded, not left to split the query.
    expect(last.url).toBe("/files/upload?cwd=%2Fhome%2F.agentproto&name=paste%201.png")
    expect([...last.body]).toEqual([1, 2, 3])
    expect(last.headers["content-type"]).toBe("image/png")
  })

  it("sends the bytes verbatim from an ArrayBuffer, not the whole backing buffer of a view", async () => {
    daemon = await uploadMock()
    const backing = new Uint8Array([0, 1, 2, 3, 4, 5])
    const view = new Uint8Array(backing.buffer, 2, 3) // [2,3,4]
    await client().uploadFile("/home/.agentproto", "x.png", view, "image/png")
    const last = daemon.requests[daemon.requests.length - 1]!
    expect([...last.body]).toEqual([2, 3, 4])
  })

  it("defaults the content-type when the paste carries no mime", async () => {
    daemon = await uploadMock()
    await client().uploadFile("/home/.agentproto", "x.bin", new Uint8Array([9]), "")
    const last = daemon.requests[daemon.requests.length - 1]!
    expect(last.headers["content-type"]).toBe("application/octet-stream")
  })

  it("throws with the daemon's reason on a 413 rather than swallowing it", async () => {
    daemon = await uploadMock(() => ({ status: 413, body: { error: "file_too_large", maxBytes: 33554432 } }))
    await expect(
      client().uploadFile("/home/.agentproto", "big.png", new Uint8Array([0]), "image/png"),
    ).rejects.toThrow(/413/)
  })
})

// Inline mkdtemp to avoid a top-level import the linter would reorder.
async function mkdtemp(prefix: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises")
  const { join } = await import("node:path")
  return mkdtemp(prefix)
}
