import { writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { AddressInfo } from "node:net"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { DaemonClient, NoTranscriptError, WorkspacesRouteMissingError } from "./daemonClient.js"

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
      if (req.url === "/sessions/terminal" && req.method === "POST") return { status: 201, body: { id: "t1", kind: "terminal", status: "running", command: "claude --resume X", pid: 3, startedAt: "t", workspaceSlug: "ws", pty: true, argv: ["claude", "--resume", "X"], cwd: "/ws" } }
      if (req.url?.startsWith("/sessions/s1/kill") && req.method === "POST") return { status: 200, body: { ok: true, sessionId: "s1" } }
      if (req.url?.startsWith("/sessions/s1/interrupt") && req.method === "POST") return { status: 200, body: { ok: true, id: "s1", wasBusy: true } }
      if (req.url?.startsWith("/sessions/s1/model") && req.method === "POST") return { status: 200, body: { ok: true, id: "s1", applied: true, model: (req.body as { model?: string }).model } }
      if (req.url?.startsWith("/sessions/s1/prompt") && req.method === "POST") return { status: 200, body: { ok: true } }
      if (req.url === "/sessions/s1" && req.method === "PATCH") {
        const patch = req.body as { title?: string | null; label?: string | null }
        return { status: 200, body: { id: "s1", kind: "agent-cli", status: "running", command: "x", pid: 1, startedAt: "t", workspaceSlug: "ws", ...(patch.label ? { label: patch.label } : {}), ...(patch.title ? { title: patch.title } : {}) } }
      }
      if (req.url === "/workspaces" && req.method === "POST") {
        const body = req.body as { path: string; slug?: string; label?: string }
        return {
          status: 200,
          body: {
            version: 1,
            active: body.slug ?? "ws",
            workspaces: [{ slug: body.slug ?? "ws", path: body.path, addedAt: "t", updatedAt: "t", label: body.label }],
          },
        }
      }
      if (req.url === "/user-presets" && req.method === "GET") {
        return {
          status: 200,
          body: {
            presets: [
              { id: "fast", label: "Fast", model: "claude-opus-4-8", effort: "low" },
              { id: "deep", label: "Deep", model: "claude-opus-4-8", effort: "max" },
            ],
          },
        }
      }
      if (req.url === "/mcp" && req.method === "POST") {
        const rpc = req.body as { method: string; params: { name: string; arguments: Record<string, unknown> } }
        if (rpc.method === "tools/call" && rpc.params.name === "adapter_list") {
          return { status: 200, body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ adapters: [{ slug: "claude-code" }] }) }] } } }
        }
        if (rpc.method === "tools/call" && rpc.params.name === "catalog_models") {
          return { status: 200, body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ vendors: [{ vendor: "anthropic", products: [{ product: "claude-opus-4-8", routes: [{ route: "anthropic", ref: "anthropic/claude-opus-4-8", baseUrl: null, pricing: { inPer1M: 15, outPer1M: 75 }, runnable: true, eligibleProfiles: ["personal"], adapterModes: [], adapters: ["claude-code"], curated: true }] }] }] }) }] } } }
        }
        if (rpc.method === "tools/call" && rpc.params.name === "list_provider_presets") {
          return { status: 200, body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ presets: [{ slug: "moonshot", name: "Moonshot", status: "available", info: { schemaFlavor: "anthropic", baseUrl: "https://api.moonshot.ai/anthropic", keyEnv: "MOONSHOT_API_KEY" } }] }) }] } } }
        }
        if (rpc.method === "tools/call" && rpc.params.name === "session_events_poll") {
          return { status: 200, body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ events: [], nextCursor: 7 }) }] } } }
        }
        if (rpc.method === "tools/call" && rpc.params.name === "llm_endpoint_list_links") {
          return { status: 200, body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ links: { anthropic: "claude-subs" }, upstreams: [{ provider: "anthropic", linkedProfile: "claude-subs", eligible: [{ id: "claude-subs", method: "oauth-bearer", endpoint: "anthropic" }] }] }) }] } } }
        }
        if (rpc.method === "tools/call" && rpc.params.name === "llm_endpoint_set_upstream_link") {
          const a = rpc.params.arguments as { provider: string; profileId: string | null }
          return { status: 200, body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ ok: true, provider: a.provider, profileId: a.profileId, applied: false, restartRequired: true }) }] } } }
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

  it("POST /sessions/terminal sends the spawn body and returns 201 descriptor", async () => {
    const s = await client().spawnTerminal({ argv: ["claude", "--resume", "X"], cwd: "/ws" })
    expect(s.id).toBe("t1")
    const last = daemon.requests[daemon.requests.length - 1]!
    expect(last.method).toBe("POST")
    expect(last.url).toBe("/sessions/terminal")
    expect(last.body).toMatchObject({ argv: ["claude", "--resume", "X"], cwd: "/ws" })
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

  it("POST /sessions/:id/model sends the model body and returns the structured result", async () => {
    const res = await client().setSessionModel("s1", "opus-5")
    expect(res).toEqual({ ok: true, id: "s1", applied: true, model: "opus-5" })
    const last = daemon.requests[daemon.requests.length - 1]!
    expect(last.method).toBe("POST")
    expect(last.url).toBe("/sessions/s1/model")
    expect(last.body).toEqual({ model: "opus-5" })
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

  it("renameSession PATCHes /sessions/:id with the { title?, label? } patch and returns the descriptor", async () => {
    const desc = await client().renameSession("s1", { label: "My Session" })
    expect(desc.label).toBe("My Session")
    const last = daemon.requests[daemon.requests.length - 1]!
    expect(last.method).toBe("PATCH")
    expect(last.url).toBe("/sessions/s1")
    expect(last.body).toEqual({ label: "My Session" })
  })

  it("renameSession forwards an explicit null to clear a field", async () => {
    await client().renameSession("s1", { label: null })
    const last = daemon.requests[daemon.requests.length - 1]!
    expect(last.method).toBe("PATCH")
    expect(last.body).toEqual({ label: null })
  })

  it("POST /workspaces sends { path, slug, label } and returns the updated WorkspacesConfig", async () => {
    const config = await client().addWorkspace("/Code/new-project", { slug: "np", label: "New Project" })
    expect(config.workspaces).toEqual([
      { slug: "np", path: "/Code/new-project", addedAt: "t", updatedAt: "t", label: "New Project" },
    ])
    const last = daemon.requests[daemon.requests.length - 1]!
    expect(last.method).toBe("POST")
    expect(last.url).toBe("/workspaces")
    expect(last.body).toEqual({ path: "/Code/new-project", slug: "np", label: "New Project" })
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

  it("catalogModels() routes through mcpCall catalog_models", async () => {
    const catalog = await client().catalogModels()
    expect(catalog.vendors[0]?.vendor).toBe("anthropic")
    expect(catalog.vendors[0]?.products[0]?.routes[0]?.eligibleProfiles).toEqual(["personal"])
  })

  it("listProviderPresets() routes through mcpCall list_provider_presets", async () => {
    const presets = await client().listProviderPresets()
    expect(presets[0]?.slug).toBe("moonshot")
    expect(presets[0]?.info?.keyEnv).toBe("MOONSHOT_API_KEY")
  })

  it("llmEndpointListLinks() routes through mcpCall llm_endpoint_list_links", async () => {
    const result = await client().llmEndpointListLinks()
    expect(result.links).toEqual({ anthropic: "claude-subs" })
    expect(result.upstreams[0]?.eligible[0]?.id).toBe("claude-subs")
  })

  it("llmEndpointSetUpstreamLink() sends provider + profileId and returns the restart signal", async () => {
    const result = await client().llmEndpointSetUpstreamLink("anthropic", "claude-subs")
    expect(result).toMatchObject({ ok: true, provider: "anthropic", profileId: "claude-subs", restartRequired: true })
    const last = daemon.requests[daemon.requests.length - 1]!
    expect((last.body as { params: { arguments: unknown } }).params.arguments).toMatchObject({
      provider: "anthropic",
      profileId: "claude-subs",
    })
  })

  it("llmEndpointSetUpstreamLink(null) clears a link", async () => {
    const result = await client().llmEndpointSetUpstreamLink("anthropic", null)
    expect(result.profileId).toBeNull()
  })

  it("listUserPresets() returns the user's saved presets from GET /user-presets", async () => {
    const presets = await client().listUserPresets()
    expect(presets).toHaveLength(2)
    expect(presets[0]?.id).toBe("fast")
    expect(presets[0]?.label).toBe("Fast")
    expect(presets[0]?.model).toBe("claude-opus-4-8")
    expect(presets[0]?.effort).toBe("low")
    expect(presets[1]?.id).toBe("deep")
    expect(presets[1]?.label).toBe("Deep")
    expect(presets[1]?.effort).toBe("max")
  })

  it("listUserPresets() degrades to empty array when presets field is missing", async () => {
    daemon.server.removeAllListeners("request")
    daemon.server.on("request", (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({}))
    })
    const presets = await client().listUserPresets()
    expect(presets).toEqual([])
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

  it("authHeaders override: sends the configured headers instead of Bearer", async () => {
    const c = new DaemonClient({
      daemonUrl: daemon.url,
      tokenPath: "",
      pollIntervalMs: 5000,
      authHeaders: { Cookie: "_port_auth=box-token" },
    })
    await c.health()
    const last = daemon.requests[daemon.requests.length - 1]!
    expect(last.headers.authorization).toBeUndefined()
    expect(last.headers.cookie).toBe("_port_auth=box-token")
  })

  it("authHeaders take precedence over a resolved bearer token", async () => {
    const { writeFile, mkdir, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = await mkdtemp(join(tmpdir(), "agentproto-vscode-test-"))
    const tokenFile = join(dir, "runtime.json")
    await writeFile(tokenFile, JSON.stringify({ token: "secret-token-123" }), "utf8")
    try {
      const c = new DaemonClient({
        daemonUrl: daemon.url,
        tokenPath: tokenFile,
        pollIntervalMs: 5000,
        authHeaders: { Cookie: "_port_auth=box-token" },
      })
      await c.health()
      const last = daemon.requests[daemon.requests.length - 1]!
      expect(last.headers.authorization).toBeUndefined()
      expect(last.headers.cookie).toBe("_port_auth=box-token")
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

describe("DaemonClient.addWorkspace — old daemon (no POST /workspaces route)", () => {
  let daemon: Awaited<ReturnType<typeof mockDaemon>>

  beforeEach(async () => {
    // No /workspaces handler at all — every route falls through to the
    // mock's default 404, standing in for a daemon that predates the
    // isomorphic workspace verbs (PR A).
    daemon = await mockDaemon(() => ({ status: 404, body: { error: "not_found" } }))
  })

  afterEach(async () => {
    await new Promise<void>(resolve => daemon.server.close(() => resolve()))
  })

  it("raises WorkspacesRouteMissingError, not a generic HTTP error", async () => {
    const client = new DaemonClient({ daemonUrl: daemon.url, tokenPath: "", pollIntervalMs: 5000 })
    await expect(client.addWorkspace("/Code/whatever")).rejects.toBeInstanceOf(WorkspacesRouteMissingError)
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

interface GatedState {
  /** Rotate mid-test to replay what a daemon restart looks like to a client. */
  expectedToken: string
  workspace: string
  /** Fires as a 401 goes out — the hook a test uses to land a new token on disk. */
  onReject?: () => void
}

/**
 * A mock daemon that gates everything but /health on `state.expectedToken`,
 * rejecting with the runtime's REAL `sessions_unauthorized` 401 body
 * (http-server.ts:581) so the client's retry trigger is exercised against the
 * exact shape it matches on.
 */
async function gatedMock(state: GatedState): Promise<{
  url: string
  port: number
  server: Server
  requests: Array<{ url: string; method: string; authorization: string | undefined }>
}> {
  const requests: Array<{ url: string; method: string; authorization: string | undefined }> = []
  const server = createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      const raw = req.headers.authorization
      const authorization = typeof raw === "string" ? raw : undefined
      requests.push({ url: req.url ?? "/", method: req.method ?? "GET", authorization })
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" })
        res.end(JSON.stringify(body))
      }
      // /health is the daemon's public, ungated liveness probe — and how the
      // client learns which workspace to read runtime.json from.
      if (req.url === "/health") {
        json(200, { status: "ok", workspace: state.workspace, registered: [] })
        return
      }
      if (authorization !== `Bearer ${state.expectedToken}`) {
        state.onReject?.()
        json(401, {
          error: "sessions_unauthorized",
          message: "Invalid bearer token.",
          receivedAuthHeader: authorization !== undefined,
        })
        return
      }
      json(200, { id: "s2", kind: "agent-cli", status: "starting", command: "c", pid: 2, startedAt: "t", workspaceSlug: "ws" })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, port, server, requests }
}

describe("DaemonClient — bearer refresh across a daemon restart", () => {
  let home: string
  let workspace: string
  let daemon: Awaited<ReturnType<typeof gatedMock>>
  let state: GatedState

  beforeEach(async () => {
    const { mkdir } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    home = await mkdtemp(join(tmpdir(), "agentproto-vscode-home-"))
    workspace = await mkdtemp(join(tmpdir(), "agentproto-vscode-ws-"))
    await mkdir(join(home, ".agentproto", "daemons"), { recursive: true })
    await mkdir(join(workspace, ".agentproto"), { recursive: true })
    state = { expectedToken: "boot-2-token", workspace }
    daemon = await gatedMock(state)
  })

  afterEach(async () => {
    await new Promise<void>(resolve => daemon.server.close(() => resolve()))
    const { rm } = await import("node:fs/promises")
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  })

  function client(tokenPath = ""): DaemonClient {
    return new DaemonClient({ daemonUrl: daemon.url, tokenPath, pollIntervalMs: 5000 }, fetch, home)
  }

  async function writeJson(path: string, value: unknown): Promise<void> {
    const { writeFile } = await import("node:fs/promises")
    await writeFile(path, JSON.stringify(value), "utf8")
  }

  async function registryPath(): Promise<string> {
    const { join } = await import("node:path")
    return join(home, ".agentproto", "daemons", `${daemon.port}.json`)
  }

  async function workspaceMetaPath(): Promise<string> {
    const { join } = await import("node:path")
    return join(workspace, ".agentproto", "runtime.json")
  }

  it("re-resolves and replays once when the daemon rebooted behind a cached token", async () => {
    const registry = await registryPath()
    await writeJson(registry, { token: "boot-1-token", pid: process.pid, port: daemon.port })
    const c = client()
    // Prime the cache on the pre-restart token, as a long-lived extension host does.
    expect(await c.resolveToken()).toBe("boot-1-token")
    // The daemon reboots: fresh token in RAM, and rewritten on disk.
    state.onReject = () =>
      writeFileSync(
        registry,
        JSON.stringify({ token: "boot-2-token", pid: process.pid, port: daemon.port }),
        "utf8",
      )

    const session = await c.spawnAgent({ adapter: "claude-code" })

    expect(session.id).toBe("s2")
    expect(daemon.requests.map(r => r.authorization)).toEqual([
      "Bearer boot-1-token",
      "Bearer boot-2-token",
    ])
  })

  it("surfaces the 401 and retries EXACTLY once when the re-resolved token is also rejected", async () => {
    // No pid on this entry: a pid-less registry file must stay trusted.
    await writeJson(await registryPath(), { token: "stale-token", port: daemon.port })

    await expect(client().spawnAgent({ adapter: "claude-code" })).rejects.toThrow(/401/)

    const gated = daemon.requests.filter(r => r.url === "/sessions/agent")
    expect(gated).toHaveLength(2)
    expect(gated.map(r => r.authorization)).toEqual(["Bearer stale-token", "Bearer stale-token"])
  })

  it("prefers the port-keyed registry over a workspace runtime.json holding another daemon's token", async () => {
    await writeJson(await registryPath(), {
      token: "boot-2-token",
      pid: process.pid,
      port: daemon.port,
    })
    // A short-lived second daemon on the same workspace root clobbered the
    // (not port-keyed) workspace file with a token that isn't ours.
    await writeJson(await workspaceMetaPath(), {
      token: "other-daemon-token",
      pid: process.pid,
      port: daemon.port + 1,
    })
    const c = client()

    expect(await c.resolveToken()).toBe("boot-2-token")
    expect((await c.spawnAgent({ adapter: "claude-code" })).id).toBe("s2")
  })

  it("falls back to the workspace runtime.json when it names the daemon's own port", async () => {
    await writeJson(await workspaceMetaPath(), {
      token: "boot-2-token",
      pid: process.pid,
      port: daemon.port,
    })

    expect(await client().resolveToken()).toBe("boot-2-token")
  })

  it("keeps config.tokenPath ahead of both the registry and the workspace file", async () => {
    const { join } = await import("node:path")
    const explicit = join(home, "explicit.json")
    // No port field: an explicit override is the user's word, not port-matched.
    await writeJson(explicit, { token: "boot-2-token" })
    await writeJson(await registryPath(), { token: "registry-token", pid: process.pid, port: daemon.port })
    await writeJson(await workspaceMetaPath(), { token: "workspace-token", pid: process.pid, port: daemon.port })
    const c = client(explicit)

    expect(await c.resolveToken()).toBe("boot-2-token")
    expect((await c.spawnAgent({ adapter: "claude-code" })).id).toBe("s2")
  })

  it("ignores a registry entry whose daemon is gone instead of replaying its token", async () => {
    // A daemon that died without cleaning up leaves its entry behind.
    await writeJson(await registryPath(), { token: "dead-daemon-token", pid: 0x7fffffff, port: daemon.port })
    await writeJson(await workspaceMetaPath(), { token: "boot-2-token", pid: process.pid, port: daemon.port })

    expect(await client().resolveToken()).toBe("boot-2-token")
  })
})

describe("DaemonClient — llmEndpointReloadPacks", () => {
  it("reads the status baseUrl, POSTs /v1/packs/reload directly, and returns the result", async () => {
    let base = ""
    const daemon = await mockDaemon(req => {
      if (req.url === "/mcp" && req.method === "POST") {
        const rpc = req.body as { params?: { name?: string } }
        if (rpc.params?.name === "llm_endpoint_status") {
          return {
            status: 200,
            body: {
              jsonrpc: "2.0",
              id: 1,
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      running: true,
                      pid: 1,
                      port: 18090,
                      baseUrl: base,
                      healthy: true,
                      startedAt: "t",
                      status: "running",
                    }),
                  },
                ],
              },
            },
          }
        }
        return { status: 200, body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "{}" }] } } }
      }
      if (req.url === "/v1/packs/reload" && req.method === "POST") {
        return {
          status: 200,
          body: {
            object: "packs.reload",
            reloaded: true,
            source: "/ws/packs.local.json",
            local_pack_ids: ["mine"],
            pack_ids: ["default", "mine"],
            count: 2,
          },
        }
      }
      return { status: 404 }
    })
    base = daemon.url
    try {
      const client = new DaemonClient({ daemonUrl: daemon.url, tokenPath: "", pollIntervalMs: 5000 })
      const result = await client.llmEndpointReloadPacks()
      expect(result.count).toBe(2)
      expect(result.local_pack_ids).toEqual(["mine"])
      expect(result.pack_ids).toContain("default")
      // It resolved the status via MCP, then reached the proxy route directly.
      expect(daemon.requests.some(r => r.url === "/v1/packs/reload" && r.method === "POST")).toBe(true)
    } finally {
      daemon.server.close()
    }
  })

  it("throws with the field-scoped errors when the reload is rejected (HTTP 400)", async () => {
    let base = ""
    const daemon = await mockDaemon(req => {
      if (req.url === "/mcp" && req.method === "POST") {
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ running: true, pid: 1, port: 18090, baseUrl: base, healthy: true, startedAt: "t", status: "running" }),
                },
              ],
            },
          },
        }
      }
      if (req.url === "/v1/packs/reload") {
        return {
          status: 400,
          body: {
            error: {
              type: "invalid_request_error",
              message: "Invalid packs.local.json",
              errors: ["/ws/packs.local.json: packs.bad.models.z.provider: required non-empty string"],
            },
          },
        }
      }
      return { status: 404 }
    })
    base = daemon.url
    try {
      const client = new DaemonClient({ daemonUrl: daemon.url, tokenPath: "", pollIntervalMs: 5000 })
      await expect(client.llmEndpointReloadPacks()).rejects.toThrow(/packs\.bad\.models\.z\.provider/)
    } finally {
      daemon.server.close()
    }
  })

  it("throws when the router is not running (no base URL)", async () => {
    const daemon = await mockDaemon(req => {
      if (req.url === "/mcp" && req.method === "POST") {
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [
                { type: "text", text: JSON.stringify({ running: false, pid: null, port: null, baseUrl: null, healthy: false, startedAt: null, status: "never-started" }) },
              ],
            },
          },
        }
      }
      return { status: 404 }
    })
    try {
      const client = new DaemonClient({ daemonUrl: daemon.url, tokenPath: "", pollIntervalMs: 5000 })
      await expect(client.llmEndpointReloadPacks()).rejects.toThrow(/not running/)
      expect(daemon.requests.every(r => r.url !== "/v1/packs/reload")).toBe(true)
    } finally {
      daemon.server.close()
    }
  })
})

describe("DaemonClient — llmEndpointTestUpstream", () => {
  it("reads the status baseUrl, POSTs /v1/upstreams/:p/test directly, and returns the verdict", async () => {
    let base = ""
    const daemon = await mockDaemon(req => {
      if (req.url === "/mcp" && req.method === "POST") {
        const rpc = req.body as { params?: { name?: string } }
        if (rpc.params?.name === "llm_endpoint_status") {
          return {
            status: 200,
            body: {
              jsonrpc: "2.0",
              id: 1,
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      running: true,
                      pid: 1,
                      port: 18090,
                      baseUrl: base,
                      healthy: true,
                      startedAt: "t",
                      status: "running",
                    }),
                  },
                ],
              },
            },
          }
        }
        return { status: 200, body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "{}" }] } } }
      }
      if (req.url === "/v1/upstreams/anthropic/test" && req.method === "POST") {
        return { status: 200, body: { provider: "anthropic", ok: true, status: 200, detail: "authenticated ok" } }
      }
      return { status: 404 }
    })
    base = daemon.url
    try {
      const client = new DaemonClient({ daemonUrl: daemon.url, tokenPath: "", pollIntervalMs: 5000 })
      const result = await client.llmEndpointTestUpstream("anthropic")
      expect(result).toEqual({ provider: "anthropic", ok: true, status: 200, detail: "authenticated ok" })
      // It resolved the status via MCP, then reached the proxy route directly.
      expect(daemon.requests.some(r => r.url === "/v1/upstreams/anthropic/test" && r.method === "POST")).toBe(true)
    } finally {
      daemon.server.close()
    }
  })

  it("throws when the router is not running (no base URL)", async () => {
    const daemon = await mockDaemon(req => {
      if (req.url === "/mcp" && req.method === "POST") {
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [
                { type: "text", text: JSON.stringify({ running: false, pid: null, port: null, baseUrl: null, healthy: false, startedAt: null, status: "never-started" }) },
              ],
            },
          },
        }
      }
      return { status: 404 }
    })
    try {
      const client = new DaemonClient({ daemonUrl: daemon.url, tokenPath: "", pollIntervalMs: 5000 })
      await expect(client.llmEndpointTestUpstream("anthropic")).rejects.toThrow(/not running/)
      expect(daemon.requests.every(r => !r.url.startsWith("/v1/upstreams/"))).toBe(true)
    } finally {
      daemon.server.close()
    }
  })
})

// Inline mkdtemp to avoid a top-level import the linter would reorder.
async function mkdtemp(prefix: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises")
  const { join } = await import("node:path")
  return mkdtemp(prefix)
}
