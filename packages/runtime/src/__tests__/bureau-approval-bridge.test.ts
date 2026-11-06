/**
 * CONTRACT.md W3: a Bureau recipe-write `browser:approval_required` becomes a
 * daemon approval, and the human's decision is relayed to Bureau's W2 route.
 *
 * The fake Bureau below implements W1 (the richer error details) and W2
 * (`POST /pair/approvals/<requestId>`) exactly as the contract states. It is
 * modelled on `browser-proxy-owner.test.ts`, which already fakes
 * `/pair/subsessions` and `/mcp` for an `aip-59` import.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import { createGateway, type GatewayHandle } from "../index.js"
import {
  IMPORTED_MCPS_PATH,
  saveImportedMcps,
  type ImportedMcpEntry,
} from "../mcp-imports.js"
import { approvalCardResourceUri } from "../approvals/card.js"
import { createBureauApprovalBridge } from "../approvals/bureau-bridge.js"
import { createApprovalsEngine } from "../approvals/engine.js"
import { createSessionEventBus } from "../session-event-bus.js"

const IMPORT_ID = "fixture:global:bureau-approval"
const IMPORT_ALIAS = "bureau"
const INPUT_SHA = "a".repeat(64)
const EXPIRES_AT = new Date(Date.now() + 15 * 60 * 1000).toISOString()

interface W2Call {
  requestId: string
  body: Record<string, unknown>
  subsession: string | undefined
}

interface FakeBureau {
  url: string
  calls: W2Call[]
  failApprovals: boolean
  close(): Promise<void>
}

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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ""
    req.setEncoding("utf8")
    req.on("data", chunk => (body += chunk))
    req.on("end", () => resolve(body))
    req.on("error", reject)
  })
}

function bureauErrorBody(requestId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: "browser:approval_required",
    error: "a human approval is required before this write runs",
    recipe: "linkedin",
    version: "1.0.1",
    tool: "linkedin_react",
    requestId,
    approveWith: `bureau recipe approve ${requestId}`,
    inputSha256: INPUT_SHA,
    preview: "React to a post",
    expiresAt: EXPIRES_AT,
    deviceDecision: true,
    ...overrides,
  }
}

function bureauError(
  requestId: string,
  overrides: Record<string, unknown> = {},
): { isError: true; content: Array<{ type: "text"; text: string }> } {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(bureauErrorBody(requestId, overrides)) }],
  }
}

async function startFakeBureau(): Promise<FakeBureau> {
  const state = { calls: [] as W2Call[] }
  let counter = 0
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.pathname === "/pair/subsessions" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { sessionId?: string }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          token: `tok-${body.sessionId ?? ""}`,
          sessionId: body.sessionId,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      )
      return
    }
    if (url.pathname.startsWith("/pair/subsessions/") && req.method === "DELETE") {
      res.writeHead(204)
      res.end()
      return
    }
    if (url.pathname.startsWith("/pair/approvals/") && req.method === "POST") {
      const requestId = decodeURIComponent(url.pathname.slice("/pair/approvals/".length))
      const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>
      const subsession = req.headers["agentproto-subsession"]
      state.calls.push({
        requestId,
        body,
        subsession: typeof subsession === "string" ? subsession : undefined,
      })
      if (bureau.failApprovals) {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "boom" }))
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ requestId, status: body.decision }))
      return
    }
    if (url.pathname === "/mcp") {
      const mcp = new McpServer({ name: "fake-bureau-approval", version: "1.0.0" })
      mcp.registerTool("linkedin_react", { description: "react to a post" }, async () => {
        counter += 1
        return bureauError(`req_${counter}`)
      })
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on("close", () => {
        void transport.close()
        void mcp.close()
      })
      await mcp.connect(transport)
      await transport.handleRequest(req, res)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  const bureau: FakeBureau = {
    url: `http://127.0.0.1:${port}`,
    get calls() {
      return state.calls
    },
    failApprovals: false,
    async close() {
      server.closeAllConnections?.()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
  return bureau
}

function entry(
  url: string,
  options: {
    alias?: string
    id?: string
    bureau?: boolean
    headers?: Record<string, string>
  } = {},
): ImportedMcpEntry {
  const alias = options.alias ?? IMPORT_ALIAS
  const id = options.id ?? IMPORT_ID
  return {
    id,
    alias,
    addedAt: "2026-01-01T00:00:00.000Z",
    snapshot: {
      id,
      source: "workspace",
      scope: "workspace",
      name: alias,
      type: "http",
      url: `${url}/mcp`,
      ...(options.headers ? { headers: options.headers } : {}),
    },
    ...(options.bureau === false ? {} : { subsession: "aip-59" as const }),
  }
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error("timed out waiting for condition")
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

interface Harness {
  bureau: FakeBureau
  gateway: GatewayHandle
  sessionId: string
}

describe("Bureau approval bridge", () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup()
      } catch {
        // teardown is best effort
      }
    }
    vi.restoreAllMocks()
  })

  async function setup(
    options: { nonBureauImport?: boolean; importHeaders?: Record<string, string> } = {},
  ): Promise<Harness> {
    const bureau = await startFakeBureau()
    cleanups.push(() => bureau.close())
    const workspace = mkdtempSync(join(tmpdir(), "bureau-approval-ws-"))
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }))
    mkdirSync(join(process.env["HOME"]!, ".agentproto"), { recursive: true })
    mkdirSync(join(workspace, ".agentproto"), { recursive: true })
    writeFileSync(
      join(process.env["HOME"]!, ".agentproto", "config.json"),
      JSON.stringify({ approvals: { webOrigins: ["https://web.example.invalid"] } }),
      "utf8",
    )
    const imports = [
      entry(bureau.url, options.importHeaders ? { headers: options.importHeaders } : {}),
    ]
    if (options.nonBureauImport) {
      imports.push(entry(bureau.url, { alias: "not-bureau", id: "not-bureau-id", bureau: false }))
    }
    await saveImportedMcps({ version: 1, imports }, IMPORTED_MCPS_PATH())
    const gateway: GatewayHandle = await createGateway({
      workspace,
      specs: [],
      port: await freePort(),
      boot: false,
      persist: false,
    })
    cleanups.push(() => gateway.stop())

    const sessionId = "sess_bureau_approval"
    const child: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    })
    cleanups.push(() => {
      if (!child.killed) child.kill("SIGKILL")
    })
    gateway.sessions.register({
      child,
      id: sessionId,
      workspaceSlug: "default",
      command: "fake-agent",
      cwd: workspace,
      kind: "agent-cli",
    })
    return { bureau, gateway, sessionId }
  }

  async function callViaDaemonMcp(
    gateway: GatewayHandle,
    sessionId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content?: Array<{ type: string; text?: string }>; isError?: boolean; _meta?: unknown }> {
    const client = new Client({ name: "bureau-approval", version: "0.0.1" })
    const transport = new StreamableHTTPClientTransport(
      new URL(`${gateway.url}/mcp?callerSessionId=${encodeURIComponent(sessionId)}`),
    )
    await client.connect(transport)
    try {
      return (await client.callTool({ name, arguments: args })) as never
    } finally {
      await client.close()
    }
  }

  async function callViaImportMount(
    gateway: GatewayHandle,
    sessionId: string,
    importId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content?: Array<{ type: string; text?: string }>; isError?: boolean; _meta?: unknown }> {
    const client = new Client({ name: "bureau-approval-mount", version: "0.0.1" })
    const transport = new StreamableHTTPClientTransport(
      new URL(
        `${gateway.url}/mcp/imported/${encodeURIComponent(importId)}?callerSessionId=${encodeURIComponent(sessionId)}`,
      ),
    )
    await client.connect(transport)
    try {
      return (await client.callTool({ name, arguments: args })) as never
    } finally {
      await client.close()
    }
  }

  function bodyOf(result: { content?: Array<{ type: string; text?: string }> }): Record<string, unknown> {
    const text = result.content?.find(c => c.type === "text")?.text
    if (!text) throw new Error("tool returned no text content")
    return JSON.parse(text) as Record<string, unknown>
  }

  async function requestBureauApproval(h: Harness): Promise<{ approvalId: string; requestId: string }> {
    const result = await callViaDaemonMcp(h.gateway, h.sessionId, "mcp_imported_call", {
      alias: IMPORT_ALIAS,
      toolName: "linkedin_react",
      args: { text: "hello" },
    })
    const body = bodyOf(result)
    expect(typeof body["approvalId"]).toBe("string")
    expect(body["waitWith"]).toBe("approval_wait")
    expect(result._meta).toEqual({
      ui: { resourceUri: approvalCardResourceUri(body["approvalId"] as string) },
    })
    return { approvalId: body["approvalId"] as string, requestId: body["requestId"] as string }
  }

  it("turns the W1 error into a bureau.recipe-write approval the agent can wait on", async () => {
    const h = await setup()
    const { approvalId, requestId } = await requestBureauApproval(h)

    const record = h.gateway.approvals.get(approvalId)
    expect(record).toBeDefined()
    expect(record?.kind).toBe("bureau.recipe-write")
    expect(record?.title).toBe("linkedin · linkedin_react")
    expect(record?.status).toBe("pending")
    expect(record?.requestedBy).toEqual({ sessionId: h.sessionId })
    expect(record?.expiresAt).toBe(EXPIRES_AT)
    expect(record?.preview).toEqual({
      recipe: "linkedin",
      version: "1.0.1",
      tool: "linkedin_react",
      preview: "React to a post",
      inputSha256: INPUT_SHA,
    })
    expect(requestId).toMatch(/^req_/)
  })

  it("approve decides through the engine and relays approved to W2 without a sub-session header", async () => {
    // A mixed-case header must be stripped too: HTTP header names are
    // case-insensitive, so exact-spelling matching would leak it to Bureau
    // and let a sub-session credential attempt a decision.
    const h = await setup({
      importHeaders: {
        "AgentProto-SubSession": "must-not-reach-w2",
        Authorization: "Bearer device-credential",
      },
    })
    const { approvalId, requestId } = await requestBureauApproval(h)

    await h.gateway.approvals.decideWeb(approvalId, "approve", {
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
    })
    const call = await waitFor(() => h.bureau.calls[0])
    expect(call.requestId).toBe(requestId)
    expect(call.body).toEqual({
      decision: "approved",
      inputSha256: INPUT_SHA,
      decisionRef: approvalId,
    })
    expect(call.subsession).toBeUndefined()
    expect(h.gateway.approvals.get(approvalId)?.status).toBe("approved")
  })

  it("works through the per-import mount the browser bundle uses, not only mcp_imported_call", async () => {
    const h = await setup()
    const result = await callViaImportMount(h.gateway, h.sessionId, IMPORT_ID, "linkedin_react", {
      text: "hello",
    })
    const body = bodyOf(result)
    expect(typeof body["approvalId"]).toBe("string")
    expect(result._meta).toEqual({
      ui: { resourceUri: approvalCardResourceUri(body["approvalId"] as string) },
    })
    const approvalId = body["approvalId"] as string
    expect(h.gateway.approvals.get(approvalId)?.kind).toBe("bureau.recipe-write")

    await h.gateway.approvals.decideWeb(approvalId, "approve", {
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
    })
    const call = await waitFor(() => h.bureau.calls[0])
    expect(call.body["decision"]).toBe("approved")
    expect(call.body["decisionRef"]).toBe(approvalId)
    expect(call.subsession).toBeUndefined()
  })

  it("relays denied when the human denies", async () => {
    const h = await setup()
    const { approvalId, requestId } = await requestBureauApproval(h)

    await h.gateway.approvals.decideWeb(approvalId, "deny", {
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
    })
    const call = await waitFor(() => h.bureau.calls[0])
    expect(call.requestId).toBe(requestId)
    expect(call.body["decision"]).toBe("denied")
    expect(call.body["inputSha256"]).toBe(INPUT_SHA)
    expect(call.body["decisionRef"]).toBe(approvalId)
  })

  it("relays through a fresh bridge after the creating bridge is disposed (restart safe)", async () => {
    const home = mkdtempSync(join(tmpdir(), "bureau-approval-restart-"))
    cleanups.push(() => rmSync(home, { recursive: true, force: true }))
    const bus = createSessionEventBus()
    const engine = createApprovalsEngine({
      homeDir: home,
      sessionEvents: bus,
      webOrigins: ["https://web.example.invalid"],
    })
    cleanups.push(() => engine.dispose())

    const callsA: Array<Record<string, unknown>> = []
    const callsB: Array<Record<string, unknown>> = []
    const makeFetch = (calls: Array<Record<string, unknown>>): typeof fetch =>
      (async (_input: unknown, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>)
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
      }) as typeof fetch
    const resolveImport = async () => ({
      baseUrl: "https://bureau.example.invalid",
      headers: {},
      key: IMPORT_ALIAS,
    })

    const bridgeA = createBureauApprovalBridge({
      engine,
      sessionEvents: bus,
      resolveImport,
      fetch: makeFetch(callsA),
    })
    const result = bureauError("req_restart")
    const augmented = (await bridgeA.handleToolResult({
      alias: IMPORT_ALIAS,
      toolName: "linkedin_react",
      result,
      context: { callerSessionId: "sess_restart" },
    })) as { content: Array<{ type: string; text?: string }> }
    const approvalId = JSON.parse(
      augmented.content.find(c => c.type === "text")?.text ?? "{}",
    ).approvalId as string
    expect(engine.get(approvalId)?.kind).toBe("bureau.recipe-write")

    // The daemon restarts: the bridge that created the approval is gone, a
    // fresh one subscribes to the same engine/bus. The decision must still
    // relay because the payload lives on the persisted record.
    bridgeA.dispose()
    const bridgeB = createBureauApprovalBridge({
      engine,
      sessionEvents: bus,
      resolveImport,
      fetch: makeFetch(callsB),
    })
    cleanups.push(() => bridgeB.dispose())

    await engine.decideWeb(approvalId, "approve", {
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
    })
    await waitFor(() => callsB[0])
    expect(callsA).toHaveLength(0)
    expect(callsB).toHaveLength(1)
    expect(callsB[0]).toEqual({
      decision: "approved",
      inputSha256: INPUT_SHA,
      decisionRef: approvalId,
    })
  })

  it("no agent-callable path can decide: the approval stays pending", async () => {
    const h = await setup()
    const { approvalId } = await requestBureauApproval(h)

    const { tools } = await (async () => {
      const client = new Client({ name: "bureau-approval-list", version: "0.0.1" })
      const transport = new StreamableHTTPClientTransport(
        new URL(`${h.gateway.url}/mcp?callerSessionId=${encodeURIComponent(h.sessionId)}`),
      )
      await client.connect(transport)
      try {
        return await client.listTools()
      } finally {
        await client.close()
      }
    })()
    // The card-decide tool is only mounted on the human approval-cards surface.
    expect(tools.some(t => t.name === "approval_card_decide")).toBe(false)

    // A session caller can request (that path is model-visible and safe)…
    const requested = bodyOf(
      await callViaDaemonMcp(h.gateway, h.sessionId, "approval_request", {
        kind: "test",
        title: "test",
        preview: {},
        payload: { x: 1 },
      }),
    )
    expect(requested["status"]).toBe("pending")

    // …but no tool decides the Bureau approval.
    const consumed = bodyOf(
      await callViaDaemonMcp(h.gateway, h.sessionId, "approval_consume", {
        id: approvalId,
        payload: { importAlias: IMPORT_ALIAS, requestId: "req_1", inputSha256: INPUT_SHA },
      }),
    )
    expect(consumed["error"]).toBe("approval_not_approved")

    const responded = bodyOf(
      await callViaDaemonMcp(h.gateway, h.sessionId, "permissions_respond", {
        id: approvalId,
        decision: "approve",
      }),
    )
    expect(responded["error"]).toBe("not_found")

    const got = bodyOf(await callViaDaemonMcp(h.gateway, h.sessionId, "approval_get", { id: approvalId }))
    expect(got["status"]).toBe("pending")
    expect(h.gateway.approvals.get(approvalId)?.status).toBe("pending")
    expect(h.bureau.calls).toHaveLength(0)
  })

  it("a non-Bureau import returning the same error text creates no approval", async () => {
    const h = await setup({ nonBureauImport: true })
    const result = await callViaDaemonMcp(h.gateway, h.sessionId, "mcp_imported_call", {
      alias: "not-bureau",
      toolName: "linkedin_react",
      args: { text: "hello" },
    })
    const body = bodyOf(result)
    expect(body["code"]).toBe("browser:approval_required")
    expect(body["approvalId"]).toBeUndefined()
    expect(result._meta).toBeUndefined()
    expect(h.gateway.approvals.list()).toHaveLength(0)
  })

  it("a W2 failure logs one line and does not throw", async () => {
    const h = await setup()
    h.bureau.failApprovals = true
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { approvalId } = await requestBureauApproval(h)

    await expect(
      h.gateway.approvals.decideWeb(approvalId, "approve", {
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
      }),
    ).resolves.toMatchObject({ status: "approved" })

    await waitFor(() =>
      warn.mock.calls.some(args => String(args[0]).includes("[bureau-approval-bridge]")),
    )
    expect(h.gateway.approvals.get(approvalId)?.status).toBe("approved")
  })
})

describe("Bureau approval bridge robustness", () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        cleanup()
      } catch {
        // teardown is best effort
      }
    }
  })

  const SECRET = "Bearer device-secret-do-not-persist"
  const RETRY = { baseDelayMs: 5, maxDelayMs: 20, maxAttempts: 50 }

  function newEngine(home: string, bus = createSessionEventBus()) {
    const engine = createApprovalsEngine({
      homeDir: home,
      sessionEvents: bus,
      webOrigins: ["https://web.example.invalid"],
    })
    cleanups.push(() => engine.dispose())
    return { engine, bus }
  }

  function tmpHome(): string {
    const home = mkdtempSync(join(tmpdir(), "bureau-bridge-robust-"))
    cleanups.push(() => rmSync(home, { recursive: true, force: true }))
    return home
  }

  const resolveImport = async () => ({
    baseUrl: "https://bureau.example.invalid",
    headers: { Authorization: SECRET },
    key: IMPORT_ALIAS,
  })

  function scriptedFetch(answers: Array<Response | Error>): { fetch: typeof fetch; calls: Array<Record<string, unknown>> } {
    const calls: Array<Record<string, unknown>> = []
    let i = 0
    const fn = (async (_input: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>)
      const answer = answers[Math.min(i, answers.length - 1)]!
      i += 1
      if (answer instanceof Error) throw answer
      return answer.clone()
    }) as typeof fetch
    return { fetch: fn, calls }
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

  async function requestApproval(
    bridge: ReturnType<typeof createBureauApprovalBridge>,
    requestId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ approvalId: string; result: Record<string, any> }> {
    const result = (await bridge.handleToolResult({
      alias: IMPORT_ALIAS,
      toolName: "linkedin_react",
      result: bureauError(requestId, overrides),
      context: { callerSessionId: "sess_robust" },
    })) as Record<string, any>
    const body = JSON.parse(result.content.find((c: any) => c.type === "text").text)
    return { approvalId: body.approvalId as string, result }
  }

  const decide = (engine: ReturnType<typeof createApprovalsEngine>, id: string, d: "approve" | "deny" = "approve") =>
    engine.decideWeb(id, d, { ipAddress: "127.0.0.1", userAgent: "vitest" })

  it("keeps an undelivered decision in an outbox and retries until Bureau answers 2xx", async () => {
    const home = tmpHome()
    const { engine, bus } = newEngine(home)
    const { fetch: f, calls } = scriptedFetch([
      new Error("ECONNREFUSED"),
      json(503, { error: "unavailable" }),
      json(200, { status: "approved" }),
    ])
    const bridge = createBureauApprovalBridge({
      engine,
      sessionEvents: bus,
      resolveImport,
      fetch: f,
      log: () => {},
      retry: { baseDelayMs: 40, maxDelayMs: 80, maxAttempts: 50 },
    })
    cleanups.push(() => bridge.dispose())
    const { approvalId } = await requestApproval(bridge, "req_retry")
    await decide(engine, approvalId)

    // Persisted next to the record while undelivered, and it carries no header value.
    const outboxFile = join(home, approvalId, "relay-outbox.json")
    expect(readFileSync(outboxFile, "utf8")).not.toContain("device-secret")
    await waitFor(() => (calls.length >= 3 ? true : undefined))
    await waitFor(() => (engine.listRelayOutbox().length === 0 ? true : undefined))
    expect(calls).toHaveLength(3)
    expect(calls[2]).toEqual({ decision: "approved", inputSha256: INPUT_SHA, decisionRef: approvalId })
    for (const file of readdirSync(join(home, approvalId)).filter(n => n.endsWith(".json"))) {
      expect(readFileSync(join(home, approvalId, file), "utf8")).not.toContain("device-secret")
    }
  })

  it("stops on a final 4xx and does not retry", async () => {
    const home = tmpHome()
    const { engine, bus } = newEngine(home)
    const { fetch: f, calls } = scriptedFetch([json(409, { error: "already_decided" })])
    const bridge = createBureauApprovalBridge({
      engine,
      sessionEvents: bus,
      resolveImport,
      fetch: f,
      log: () => {},
      retry: RETRY,
    })
    cleanups.push(() => bridge.dispose())
    const { approvalId } = await requestApproval(bridge, "req_final")
    await decide(engine, approvalId, "deny")

    await waitFor(() => (engine.listRelayOutbox().length === 0 ? true : undefined))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.["decision"]).toBe("denied")
  })

  it("redelivers once at boot from the persisted record after a restart", async () => {
    const home = tmpHome()
    const first = newEngine(home)
    const down = scriptedFetch([new Error("ECONNREFUSED")])
    const bridgeA = createBureauApprovalBridge({
      engine: first.engine,
      sessionEvents: first.bus,
      resolveImport,
      fetch: down.fetch,
      log: () => {},
      retry: { baseDelayMs: 60_000, maxDelayMs: 60_000, maxAttempts: 50 },
    })
    const { approvalId } = await requestApproval(bridgeA, "req_boot")
    await decide(first.engine, approvalId)
    await waitFor(() => (down.calls.length === 1 ? true : undefined))
    bridgeA.dispose()
    expect(first.engine.listRelayOutbox().map(e => e.approvalId)).toEqual([approvalId])

    // Restart: a new engine reloads the same dir, a new bridge boots.
    const second = newEngine(home)
    const up = scriptedFetch([json(200, { status: "approved" })])
    const bridgeB = createBureauApprovalBridge({
      engine: second.engine,
      sessionEvents: second.bus,
      resolveImport,
      fetch: up.fetch,
      log: () => {},
      retry: RETRY,
    })
    cleanups.push(() => bridgeB.dispose())
    await waitFor(() => up.calls[0])
    expect(up.calls[0]).toEqual({ decision: "approved", inputSha256: INPUT_SHA, decisionRef: approvalId })
    await waitFor(() => (second.engine.listRelayOutbox().length === 0 ? true : undefined))
  })

  describe("boot sweep for a decision lost before the outbox write", () => {
    /** Create an approval, then decide it with the creating bridge already gone,
     *  as if the daemon died after the engine saved the decision and before the
     *  outbox write. Returns the home dir to restart on. */
    async function decidedWithoutOutbox(requestId: string, overrides: Record<string, unknown> = {}) {
      const home = tmpHome()
      const first = newEngine(home)
      const creator = createBureauApprovalBridge({
        engine: first.engine,
        sessionEvents: first.bus,
        resolveImport,
        fetch: scriptedFetch([json(200, {})]).fetch,
        log: () => {},
        retry: RETRY,
      })
      const { approvalId } = await requestApproval(creator, requestId, overrides)
      creator.dispose()
      await decide(first.engine, approvalId)
      expect(first.engine.listRelayOutbox()).toEqual([])
      expect(first.engine.isRelayed(approvalId)).toBe(false)
      return { home, approvalId }
    }

    function boot(home: string, answers: Array<Response | Error>) {
      const second = newEngine(home)
      const up = scriptedFetch(answers)
      const bridge = createBureauApprovalBridge({
        engine: second.engine,
        sessionEvents: second.bus,
        resolveImport,
        fetch: up.fetch,
        log: () => {},
        retry: RETRY,
      })
      cleanups.push(() => bridge.dispose())
      return { engine: second.engine, calls: up.calls }
    }

    it("relays a decided approval that has no outbox entry and no marker, then writes the marker", async () => {
      const { home, approvalId } = await decidedWithoutOutbox("req_sweep")
      const { engine, calls } = boot(home, [json(200, { status: "approved" })])

      await waitFor(() => calls[0])
      expect(calls[0]).toEqual({ decision: "approved", inputSha256: INPUT_SHA, decisionRef: approvalId })
      await waitFor(() => (engine.isRelayed(approvalId) ? true : undefined))
      expect(engine.listRelayOutbox()).toEqual([])
      expect(readFileSync(join(home, approvalId, "relayed.json"), "utf8")).not.toContain("device-secret")
    })

    it("relays a denied approval the same way", async () => {
      const home = tmpHome()
      const first = newEngine(home)
      const creator = createBureauApprovalBridge({
        engine: first.engine,
        sessionEvents: first.bus,
        resolveImport,
        fetch: scriptedFetch([json(200, {})]).fetch,
        log: () => {},
      })
      const { approvalId } = await requestApproval(creator, "req_sweep_deny")
      creator.dispose()
      await decide(first.engine, approvalId, "deny")
      const { calls } = boot(home, [json(200, { status: "denied" })])
      await waitFor(() => calls[0])
      expect(calls[0]?.["decision"]).toBe("denied")
    })

    it("does not relay again once a relay has succeeded (marker present)", async () => {
      const home = tmpHome()
      const first = newEngine(home)
      const live = scriptedFetch([json(200, { status: "approved" })])
      const bridge = createBureauApprovalBridge({
        engine: first.engine,
        sessionEvents: first.bus,
        resolveImport,
        fetch: live.fetch,
        log: () => {},
        retry: RETRY,
      })
      const { approvalId } = await requestApproval(bridge, "req_marked")
      await decide(first.engine, approvalId)
      await waitFor(() => (first.engine.isRelayed(approvalId) ? true : undefined))
      bridge.dispose()
      expect(live.calls).toHaveLength(1)

      const { calls } = boot(home, [json(200, {})])
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(calls).toHaveLength(0)
    })

    it("marks a final Bureau answer as relayed too", async () => {
      const { home, approvalId } = await decidedWithoutOutbox("req_final_marker")
      const { engine, calls } = boot(home, [json(409, { error: "already_decided" })])
      await waitFor(() => calls[0])
      await waitFor(() => (engine.isRelayed(approvalId) ? true : undefined))
    })

    it("does not relay when the Bureau request has expired", async () => {
      const { home, approvalId } = await decidedWithoutOutbox("req_expired")
      const file = join(home, approvalId, "request.json")
      const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
      record["expiresAt"] = new Date(Date.now() - 60_000).toISOString()
      writeFileSync(file, JSON.stringify(record))

      const { engine, calls } = boot(home, [json(200, {})])
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(calls).toHaveLength(0)
      expect(engine.isRelayed(approvalId)).toBe(false)
    })

    it("ignores approvals of other kinds and undecided ones", async () => {
      const home = tmpHome()
      const first = newEngine(home)
      first.engine.request(
        { kind: "other.kind", title: "x", preview: {}, payload: { importAlias: "bureau", requestId: "r", inputSha256: "s" } },
        { operator: true },
      )
      const creator = createBureauApprovalBridge({
        engine: first.engine,
        sessionEvents: first.bus,
        resolveImport,
        fetch: scriptedFetch([json(200, {})]).fetch,
        log: () => {},
      })
      await requestApproval(creator, "req_still_pending")
      creator.dispose()
      const { calls } = boot(home, [json(200, {})])
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(calls).toHaveLength(0)
    })
  })

  it("reuses the pending approval when the agent retries the same Bureau requestId", async () => {
    const { engine, bus } = newEngine(tmpHome())
    const bridge = createBureauApprovalBridge({
      engine,
      sessionEvents: bus,
      resolveImport,
      fetch: scriptedFetch([json(200, {})]).fetch,
      log: () => {},
    })
    cleanups.push(() => bridge.dispose())
    const a = await requestApproval(bridge, "req_same")
    const b = await requestApproval(bridge, "req_same")
    expect(b.approvalId).toBe(a.approvalId)
    expect(engine.list()).toHaveLength(1)
    const c = await requestApproval(bridge, "req_other")
    expect(c.approvalId).not.toBe(a.approvalId)
    expect(engine.list()).toHaveLength(2)
  })

  it("echoes approvalId and waitWith into structuredContent when the details came from there", async () => {
    const { engine, bus } = newEngine(tmpHome())
    const bridge = createBureauApprovalBridge({
      engine,
      sessionEvents: bus,
      resolveImport,
      fetch: scriptedFetch([json(200, {})]).fetch,
      log: () => {},
    })
    cleanups.push(() => bridge.dispose())
    const out = (await bridge.handleToolResult({
      alias: IMPORT_ALIAS,
      toolName: "linkedin_react",
      result: {
        isError: true,
        content: [{ type: "text", text: "approval required" }],
        structuredContent: bureauErrorBody("req_structured"),
      },
    })) as { structuredContent: Record<string, unknown>; content: Array<{ text: string }> }
    const approvalId = out.structuredContent["approvalId"]
    expect(typeof approvalId).toBe("string")
    expect(out.structuredContent["waitWith"]).toBe("approval_wait")
    expect(out.structuredContent["requestId"]).toBe("req_structured")
    expect(out.content.some(c => c.text.includes(String(approvalId)))).toBe(true)
  })

  it.each([
    ["unparsable", "not a date"],
    ["already past", new Date(Date.now() - 60_000).toISOString()],
  ])("falls back to now + 15 min and logs when expiresAt is %s", async (_label, expiresAt) => {
    const { engine, bus } = newEngine(tmpHome())
    const lines: string[] = []
    const bridge = createBureauApprovalBridge({
      engine,
      sessionEvents: bus,
      resolveImport,
      fetch: scriptedFetch([json(200, {})]).fetch,
      log: m => lines.push(m),
    })
    cleanups.push(() => bridge.dispose())
    const before = Date.now()
    const { approvalId } = await requestApproval(bridge, "req_expiry", { expiresAt })
    const record = engine.get(approvalId)
    expect(record?.status).toBe("pending")
    const at = Date.parse(record?.expiresAt ?? "")
    expect(Number.isFinite(at)).toBe(true)
    expect(at).toBeGreaterThanOrEqual(before + 14 * 60 * 1000)
    expect(at).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000)
    expect(lines.some(l => l.includes("[bureau-approval-bridge]") && l.includes("expiresAt"))).toBe(true)
  })
})
