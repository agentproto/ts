/**
 * Orchestrator sub-gateway (WP2) — scoped MCP surface + scope-token gate.
 *
 * Proves the three load-bearing security properties:
 *   (a) the scoped server exposes ONLY the curated subset — danger tools
 *       like command_execute are absent;
 *   (b) a caller-requested subset wider than the default is narrowed
 *       (⊆ default) — it can never widen;
 *   (c) the `/mcp/orchestrator` HTTP endpoint requires a valid
 *       scope-token even over loopback (no auth bypass) — unknown /
 *       missing tokens are rejected, a valid token gets the subset.
 */

import { describe, it, expect, vi } from "vitest"
import { createServer } from "node:http"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AddressInfo } from "node:net"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createMcpServer } from "@agentproto/mcp-server"
import type { CompletionPolicySupervisor, PolicyRunState } from "../supervisor.js"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"

import {
  DEFAULT_ORCHESTRATOR_TOOLS,
  narrowOrchestratorTools,
  createScopeTokenRegistry,
  createOrchestratorMcpServerFactory,
  type OrchestratorScope,
} from "../orchestrator-gateway.js"
import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

// Tools that MUST NEVER appear on the scoped surface (the danger set —
// ADR §4.3). Used to assert absence rather than just checking the
// allowlist, so a future leak via createMcpServer/register* is caught.
const FORBIDDEN_TOOLS = [
  "command_execute",
  "file_read",
  "file_write",
  "file_delete",
  "directory_create",
  "remote_enable",
  "remote_disable",
  "import_mcp",
  "mcp_imported_call",
  "mcp_imported_tool_list",
  "terminal_input",
  "self_inspect",
]

/** Transcripts are written whether or not `persist` is on, and default to a
 *  sibling of the real `~/.agentproto/sessions.json` — so every registry here
 *  needs an explicit tmp dir on top of `persist: false`. */
function tmpTranscriptDir(): string {
  return join(mkdtempSync(join(tmpdir(), "agentproto-orch-gw-")), "transcripts")
}

function makeFactoryDeps() {
  const sessionEvents = createSessionEventBus()
  const eventRing = createEventRing()
  eventRing.wire(sessionEvents)
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  return { registry, sessionEvents, eventRing }
}

async function listToolNames(
  factory: ReturnType<typeof createOrchestratorMcpServerFactory>,
  scope: OrchestratorScope,
): Promise<string[]> {
  const server = await factory(scope)
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)
  const { tools } = await client.listTools()
  await client.close()
  return tools.map(t => t.name).sort()
}

describe("orchestrator sub-gateway — scoped tool subset", () => {
  it("(a) exposes exactly the default subset; danger tools are absent", async () => {
    const deps = makeFactoryDeps()
    const factory = createOrchestratorMcpServerFactory({
      workspace: process.cwd(),
      ...deps,
    })
    const scope = createScopeTokenRegistry().mint()
    const names = await listToolNames(factory, scope)

    expect(names).toEqual([...DEFAULT_ORCHESTRATOR_TOOLS].sort())
    for (const forbidden of FORBIDDEN_TOOLS) {
      expect(names).not.toContain(forbidden)
    }
    // Spot-check the headline danger tool explicitly.
    expect(names).not.toContain("command_execute")
  })

  it("(b) narrows a caller-requested subset to ⊆ default (cannot widen)", async () => {
    // Caller asks for a danger tool + a phantom tool + one legit tool.
    const requested = [
      "command_execute", // danger — must be dropped
      "remote_enable", // danger — must be dropped
      "totally_made_up", // unknown — must be dropped
      "agent_start", // legit — survives
      "session_events_poll", // legit — survives
    ]
    const narrowed = narrowOrchestratorTools(requested)
    // Pure-logic invariant: result ⊆ default, danger excluded.
    expect(narrowed.has("command_execute")).toBe(false)
    expect(narrowed.has("remote_enable")).toBe(false)
    expect(narrowed.has("totally_made_up")).toBe(false)
    expect([...narrowed].sort()).toEqual(["agent_start", "session_events_poll"])
    for (const t of narrowed) {
      expect(DEFAULT_ORCHESTRATOR_TOOLS).toContain(t)
    }

    // End-to-end: the scoped server reflects the narrowed set, nothing more.
    const deps = makeFactoryDeps()
    const factory = createOrchestratorMcpServerFactory({
      workspace: process.cwd(),
      ...deps,
    })
    const scope = createScopeTokenRegistry().mint({ tools: requested })
    const names = await listToolNames(factory, scope)
    expect(names).toEqual(["agent_start", "session_events_poll"])
    expect(names).not.toContain("command_execute")
  })

  it("scope-token registry: mint → verify roundtrip; bad/missing → null", () => {
    const reg = createScopeTokenRegistry()
    const scope = reg.mint()
    expect(scope.token).toMatch(/^[0-9a-f]{64}$/) // 256-bit hex
    expect(reg.verify(scope.token)).toBe(scope)
    expect(reg.verify("not-a-real-token")).toBeNull()
    expect(reg.verify(null)).toBeNull()
    expect(reg.verify(undefined)).toBeNull()
    reg.revoke(scope.token)
    expect(reg.verify(scope.token)).toBeNull()
  })

  it("threads daemonMcpUrl to a hermes child spawned with no mcpServers through the scoped gateway, deny-gated by the depth-derived executor default", async () => {
    // A spawn made THROUGH an orchestrator's scoped gateway lands at
    // depth 1 — at/above the default role-depth cutoff (1), so with no
    // explicit `role` it defaults to executor (spawn-role-profiles).
    // The hermes-default entry still points at the full daemon gateway
    // (fs/command tools stay available) but carries `denyTools` so the
    // daemon strips the delegation surface from what it registers.
    const deps = makeFactoryDeps()
    const daemonMcpUrl = "http://127.0.0.1:18790/mcp"
    const startSession = vi.fn(async () => ({
      sessionId: "hermes_scoped_test",
      // eslint-disable-next-line require-yield
      async *send(): AsyncIterable<AgentStreamEvent> { return },
      async cancel() {},
      async close() {},
    }))
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "hermes",
    })
    const factory = createOrchestratorMcpServerFactory({
      workspace: process.cwd(),
      ...deps,
      resolveAgentAdapter,
      daemonMcpUrl,
    })
    const scope = createScopeTokenRegistry().mint()
    const server = await factory(scope)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "hermes-default-test", version: "0.0.1" })
    await client.connect(clientTransport)

    const result = await client.callTool({
      name: "agent_start",
      arguments: { adapter: "hermes", cwd: process.cwd() },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ""
    const desc = JSON.parse(text) as {
      mcpServers?: Array<{ name: string; transport: string; ref: string }>
    }

    const expectedEntry = [
      { name: "agentproto", transport: "http", ref: `${daemonMcpUrl}?denyTools=agent_start,agent_prompt` },
    ]
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({ mcpServers: expectedEntry }),
    )
    expect(desc.mcpServers).toEqual(expectedEntry)

    await client.close()
  })

  it("keeps the plain daemonMcpUrl (no denyTools) when the caller explicitly requests role: supervisor", async () => {
    const deps = makeFactoryDeps()
    const daemonMcpUrl = "http://127.0.0.1:18790/mcp"
    const startSession = vi.fn(async () => ({
      sessionId: "hermes_scoped_supervisor_test",
      // eslint-disable-next-line require-yield
      async *send(): AsyncIterable<AgentStreamEvent> { return },
      async cancel() {},
      async close() {},
    }))
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "hermes",
    })
    const factory = createOrchestratorMcpServerFactory({
      workspace: process.cwd(),
      ...deps,
      resolveAgentAdapter,
      daemonMcpUrl,
    })
    const scope = createScopeTokenRegistry().mint()
    const server = await factory(scope)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "hermes-default-supervisor-test", version: "0.0.1" })
    await client.connect(clientTransport)

    const result = await client.callTool({
      name: "agent_start",
      arguments: { adapter: "hermes", cwd: process.cwd(), role: "supervisor" },
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ""
    const desc = JSON.parse(text) as {
      mcpServers?: Array<{ name: string; transport: string; ref: string }>
    }

    const expectedEntry = [{ name: "agentproto", transport: "http", ref: daemonMcpUrl }]
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({ mcpServers: expectedEntry }),
    )
    expect(desc.mcpServers).toEqual(expectedEntry)

    await client.close()
  })

  it("does not default mcpServers for a hermes child when daemonMcpUrl is unset (today's behaviour)", async () => {
    const deps = makeFactoryDeps()
    const startSession = vi.fn(async (_opts: Record<string, unknown>) => ({
      sessionId: "hermes_scoped_no_default_test",
      // eslint-disable-next-line require-yield
      async *send(): AsyncIterable<AgentStreamEvent> { return },
      async cancel() {},
      async close() {},
    }))
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession,
      commandPreview: "hermes",
    })
    const factory = createOrchestratorMcpServerFactory({
      workspace: process.cwd(),
      ...deps,
      resolveAgentAdapter,
      // no daemonMcpUrl
    })
    const scope = createScopeTokenRegistry().mint()
    const server = await factory(scope)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "hermes-no-default-test", version: "0.0.1" })
    await client.connect(clientTransport)

    await client.callTool({
      name: "agent_start",
      arguments: { adapter: "hermes", cwd: process.cwd() },
    })
    const calledWith = startSession.mock.calls[0]![0] as Record<string, unknown>
    expect("mcpServers" in calledWith).toBe(false)

    await client.close()
  })
})

describe("orchestrator sub-gateway — HTTP scope-token gate (no loopback bypass)", () => {
  async function withServer(
    fn: (base: string, scopeToken: string) => Promise<void>,
  ): Promise<void> {
    const deps = makeFactoryDeps()
    const scopeTokens = createScopeTokenRegistry()
    const factory = createOrchestratorMcpServerFactory({
      workspace: process.cwd(),
      ...deps,
    })
    const port = await freePort()
    const conversations = noopConversations()
    const heartbeat = noopHeartbeat()
    const http = await startHttpServer({
      port,
      // Configure bearer auth to prove the orchestrator endpoint does NOT
      // honour the loopback bypass that /mcp does (it requires the scope
      // token regardless of where the request comes from).
      auth: { mode: "none" },
      mcpServerFactory: async () =>
        (await createMcpServer({ specs: [], name: "main", version: "0" }))
          .server,
      orchestratorMcpServerFactory: factory,
      verifyOrchestratorScope: scopeTokens.verify,
      conversations,
      events: createRuntimeEvents(),
      heartbeat,
      meta: { workspace: process.cwd(), registered: [] },
    })
    const scope = scopeTokens.mint()
    try {
      await fn(`http://127.0.0.1:${port}`, scope.token)
    } finally {
      await http.stop()
    }
  }

  // A minimal JSON-RPC initialize body — enough to get past the gate to
  // the transport layer. We only assert the HTTP status differs from the
  // 401 the gate emits, so we don't need a full MCP handshake here.
  const initBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "raw", version: "0" },
    },
  })
  const mcpHeaders = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  }

  it("(c) rejects a request with NO scope-token (loopback, 401)", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/mcp/orchestrator`, {
        method: "POST",
        headers: mcpHeaders,
        body: initBody,
      })
      expect(res.status).toBe(401)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe("orchestrator_scope_required")
    })
  })

  it("(c) rejects a request with a BOGUS scope-token (401)", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/mcp/orchestrator?scope=deadbeef`, {
        method: "POST",
        headers: mcpHeaders,
        body: initBody,
      })
      expect(res.status).toBe(401)
    })
  })

  it("(c) accepts a VALID scope-token and serves only the subset", async () => {
    await withServer(async (base, scopeToken) => {
      // Negative path proven above is on loopback — so passing here proves
      // the token (not the origin) is what unlocks the endpoint.
      const client = new Client({ name: "child", version: "0.0.1" })
      const transport = new StreamableHTTPClientTransport(
        new URL(`${base}/mcp/orchestrator?scope=${scopeToken}`),
      )
      await client.connect(transport)
      const { tools } = await client.listTools()
      const names = tools.map(t => t.name).sort()
      expect(names).toEqual([...DEFAULT_ORCHESTRATOR_TOOLS].sort())
      expect(names).not.toContain("command_execute")
      await client.close()
    })
  })
})

// ── WP6 — subtree-scoped supervisor composition ──────────────────────

describe("orchestrator sub-gateway — WP6 supervisor composition (subtree scoping)", () => {
  /**
   * Build a minimal stub supervisor. attach() records the call and returns a
   * synthetic PolicyRunState so the handler can JSON.stringify the result.
   * list() / getStatus() / cancel() / ack() are stubs — just enough for the
   * scoping assertions.
   */
  function makeStubSupervisor(): CompletionPolicySupervisor & {
    attached: Array<{ sessionId?: string; sessionIds?: string[] }>
  } {
    let seq = 0
    const policies = new Map<string, PolicyRunState>()
    const attached: Array<{ sessionId?: string; sessionIds?: string[] }> = []
    const now = new Date().toISOString()
    return {
      attached,
      attach(input) {
        const policyId = `p-${++seq}`
        const ids =
          input.sessionIds && input.sessionIds.length > 0
            ? input.sessionIds
            : input.sessionId
              ? [input.sessionId]
              : []
        const state: PolicyRunState = {
          policyId,
          sessionId: ids[0] ?? "",
          sessionIds: ids,
          pending: [...ids],
          status: "watching",
          retries: 0,
          startedAt: now,
        }
        policies.set(policyId, state)
        attached.push({ sessionId: input.sessionId, sessionIds: input.sessionIds })
        return state
      },
      getStatus(policyId) {
        return policies.get(policyId)
      },
      cancel(policyId) {
        const s = policies.get(policyId)
        if (s) s.status = "cancelled"
      },
      async ack(_policyId: string, _approve: boolean) {
        return undefined
      },
      list() {
        return [...policies.values()]
      },
      onSettle() {
        return () => {}
      },
      async shutdown() {},
    }
  }

  /**
   * Build a factory wired with a stub supervisor and a prepopulated registry
   * that already has two sessions forming a parent→child tree:
   *   ownerSessionId ("owner") → childSessionId ("child")
   *
   * We then build a scoped server with callerScope = { ownerSessionId: "owner" }
   * and verify that:
   *   1. policy_attach on "child" (in subtree) → succeeds (policyId returned)
   *   2. policy_attach on "outside" (not in subtree) → error denied
   *   3. policy_attach with then:"commit" via scoped token → error refused
   */
  let fakeSessionSeq = 0
  function fakeSession(): AgentSessionLike {
    return {
      sessionId: `fake_${fakeSessionSeq++}`,
      // eslint-disable-next-line require-yield
      async *send(): AsyncIterable<AgentStreamEvent> { return },
      async cancel() {},
      async close() {},
    }
  }

  async function withScopedClient(
    fn: (client: Client, ownerSessionId: string, childSessionId: string) => Promise<void>,
  ): Promise<void> {
    const supervisor = makeStubSupervisor()
    const sessionEvents = createSessionEventBus()
    const eventRing = createEventRing()
    eventRing.wire(sessionEvents)
    const registry = createSessionsRegistry({
      sessionEvents,
      persist: false,
      transcriptDir: tmpTranscriptDir(),
    })

    // Spawn owner + child so collectSubtree(owner.id) returns {owner.id, child.id}.
    const owner = registry.spawnAgent({
      workspaceSlug: "w",
      cwd: process.cwd(),
      agentSession: fakeSession(),
      adapterSlug: "mock",
      depth: 0,
    })
    const child = registry.spawnAgent({
      workspaceSlug: "w",
      cwd: process.cwd(),
      agentSession: fakeSession(),
      adapterSlug: "mock",
      parentSessionId: owner.id,
      depth: 1,
    })

    const factory = createOrchestratorMcpServerFactory({
      workspace: process.cwd(),
      registry,
      sessionEvents,
      eventRing,
      supervisor,
    })

    // Mint a scope bound to owner.id so callerScope is active.
    const scopeTokens = createScopeTokenRegistry()
    const scope = scopeTokens.mint()
    scopeTokens.bindOwner(scope.token, owner.id)
    const boundScope = scopeTokens.verify(scope.token)!

    const server = await factory(boundScope)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "wp6-test", version: "0.0.1" })
    await client.connect(clientTransport)
    try {
      await fn(client, owner.id, child.id)
    } finally {
      await client.close()
    }
  }

  it("policy_attach on a session in the caller's subtree → ok (policyId returned)", async () => {
    await withScopedClient(async (client, _owner, child) => {
      const result = await client.callTool({
        name: "policy_attach",
        arguments: { sessionId: child, then: "emit" },
      })
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ""
      const parsed = JSON.parse(text) as { policyId?: string; error?: string }
      expect(parsed.error).toBeUndefined()
      expect(parsed.policyId).toMatch(/^p-/)
    })
  })

  it("policy_attach on a session outside the caller's subtree → denied", async () => {
    await withScopedClient(async client => {
      const result = await client.callTool({
        name: "policy_attach",
        arguments: { sessionId: "outside-session", then: "emit" },
      })
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ""
      const parsed = JSON.parse(text) as { error?: string; forbidden?: string[] }
      expect(parsed.error).toMatch(/denied|subtree/)
      expect(parsed.forbidden).toContain("outside-session")
    })
  })

  it('policy_attach with then:"commit" via a scoped (child) token → refused', async () => {
    await withScopedClient(async (client, _owner, child) => {
      const result = await client.callTool({
        name: "policy_attach",
        arguments: {
          sessionId: child,
          then: "commit",
          commit: { paths: ["README.md"], message: "test" },
        },
      })
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ""
      const parsed = JSON.parse(text) as { error?: string }
      expect(parsed.error).toMatch(/commit.*not permitted|child orchestrator/i)
    })
  })
})

// ── tiny stubs ──────────────────────────────────────────────────────

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
