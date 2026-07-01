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

import { describe, it, expect } from "vitest"
import { createServer } from "node:http"
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
import { startHttpServer } from "../http-server.js"
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
  "mcp_import",
  "mcp_imported_call",
  "mcp_imported_tool_list",
  "terminal_input",
  "self_inspect",
]

function makeFactoryDeps() {
  const sessionEvents = createSessionEventBus()
  const eventRing = createEventRing()
  eventRing.wire(sessionEvents)
  const registry = createSessionsRegistry({ sessionEvents })
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
      const res = await fetch(`${base}/mcp/orchestrator`, {
        method: "POST",
        headers: {
          ...mcpHeaders,
          authorization: "Bearer not-a-real-token",
        },
        body: initBody,
      })
      expect(res.status).toBe(401)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe("orchestrator_scope_required")
    })
  })

  it("(c) accepts a request with a VALID scope-token (gets tool subset)", async () => {
    await withServer(async (base, scopeToken) => {
      const client = new Client({ name: "test", version: "0.0.1" })
      const transport = new StreamableHTTPClientTransport(
        new URL(`${base}/mcp/orchestrator`),
        {
          requestInit: {
            headers: { authorization: `Bearer ${scopeToken}` },
          },
        },
      )
      await client.connect(transport)
      const { tools } = await client.listTools()
      await client.close()
      const names = tools.map(t => t.name).sort()
      expect(names).toEqual([...DEFAULT_ORCHESTRATOR_TOOLS].sort())
    })
  })
})

// ── Recursion-guard tests (WP4) ──────────────────────────────────────────────

import {
  DEFAULT_MAX_DEPTH,
  HARD_MAX_DEPTH,
  DEFAULT_MAX_CHILDREN,
} from "../orchestrator-gateway.js"

describe("orchestrator sub-gateway — recursion guard (WP4)", () => {
  it("mint defaults: depth=0, maxDepth=DEFAULT_MAX_DEPTH, maxChildren=DEFAULT_MAX_CHILDREN", () => {
    const reg = createScopeTokenRegistry()
    const scope = reg.mint()
    expect(scope.depth).toBe(0)
    expect(scope.maxDepth).toBe(DEFAULT_MAX_DEPTH)
    expect(scope.maxChildren).toBe(DEFAULT_MAX_CHILDREN)
  })

  it("maxDepth is clamped to HARD_MAX_DEPTH", () => {
    const reg = createScopeTokenRegistry()
    const scope = reg.mint({ maxDepth: HARD_MAX_DEPTH + 99 })
    expect(scope.maxDepth).toBe(HARD_MAX_DEPTH)
  })

  it("bindOwner late-binds ownerSessionId onto a live scope", () => {
    const reg = createScopeTokenRegistry()
    const scope = reg.mint()
    expect(scope.ownerSessionId).toBeUndefined()
    reg.bindOwner(scope.token, "sess-abc")
    expect(scope.ownerSessionId).toBe("sess-abc")
    // verify() sees the same object
    expect(reg.verify(scope.token)?.ownerSessionId).toBe("sess-abc")
  })

  it("bindOwner on an unknown token is a no-op", () => {
    const reg = createScopeTokenRegistry()
    // Should not throw
    reg.bindOwner("not-a-real-token", "sess-xyz")
  })

  it("child scope tools are ⊆ parent tools (non-re-grant)", () => {
    const reg = createScopeTokenRegistry()
    // Parent has a restricted set.
    const parentScope = reg.mint({
      tools: ["agent_start", "session_events_poll"],
    })
    // Child tries to widen — request includes a tool the parent doesn't have.
    const childScope = reg.mint({
      tools: ["agent_start", "agent_output", "session_events_poll"],
      ceiling: parentScope.tools,
    })
    // agent_output is outside the parent ceiling — must be dropped.
    expect(childScope.tools.has("agent_output")).toBe(false)
    expect([...childScope.tools].sort()).toEqual([
      "agent_start",
      "session_events_poll",
    ])
  })
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo
      srv.close(err => (err ? reject(err) : resolve(port)))
    })
  })
}

function noopConversations(): ConversationStore {
  return {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    list: async () => [],
  }
}

function noopHeartbeat(): HeartbeatRunner {
  return {
    start: () => {},
    stop: () => {},
  }
}
