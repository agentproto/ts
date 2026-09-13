/**
 * Orchestrator role auto-injection (WP3) — the `orchestrator` field on
 * `agent_start`.
 *
 * Proves the mint → inject → revoke flow end-to-end through the real
 * `agent_start` MCP tool, driven by the production
 * `createOrchestratorInjector` (no re-implementation of the closure):
 *   (a) `orchestrator: true` → the `mcpServers` handed to the adapter's
 *       `startSession` contains the scoped `agentproto` entry whose URL
 *       carries a `?scope=<token>` the scope-token registry verifies;
 *   (b) `orchestrator: { tools: [...] }` → the minted token is narrowed
 *       to ⊆ the default subset (it can never widen);
 *   (c) caller-supplied `mcpServers` (WP1) and the injected scoped entry
 *       coexist on the child's session;
 *   (d) when the child session exits, the token is revoked — `verify`
 *       fails afterwards (no token outlives its session).
 */

import { describe, it, expect } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"
import type { AcpMcpServer } from "@agentproto/acp"

import { registerSessionTools } from "../session-tools.js"
import {
  createScopeTokenRegistry,
  createOrchestratorInjector,
  DEFAULT_ORCHESTRATOR_TOOLS,
} from "../orchestrator-gateway.js"
import { createSessionsRegistry } from "../sessions.js"
import {
  createSessionEventBus,
  type SessionEventBus,
} from "../session-event-bus.js"
import type {
  AgentSessionLike,
  AgentStreamEvent,
} from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

const PORT = 18790

/** A fake ACP session — never receives turns in these tests. */
function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `acp_${Math.random().toString(36).slice(2, 10)}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

/** Captures the spawn-time `mcpServers` the handler forwards. */
interface SpawnCapture {
  mcpServers?: AcpMcpServer[]
  count: number
}

function makeResolver(capture: SpawnCapture): AgentAdapterResolver {
  return async () => ({
    async startSession(o: { mcpServers?: AcpMcpServer[] }) {
      capture.mcpServers = o.mcpServers
      capture.count += 1
      return fakeAgentSession()
    },
    commandPreview: "mock-adapter (agent)",
  })
}

/**
 * Wire a server with `registerSessionTools` (real injector) and return
 * a connected MCP client + the shared deps so tests can inspect the
 * scope-token registry / drive the event bus.
 */
async function harness(): Promise<{
  client: Client
  scopeTokens: ReturnType<typeof createScopeTokenRegistry>
  sessionEvents: SessionEventBus
  capture: SpawnCapture
  close: () => Promise<void>
}> {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const scopeTokens = createScopeTokenRegistry()
  const injector = createOrchestratorInjector({
    scopeTokens,
    sessionEvents,
    port: PORT,
  })
  const capture: SpawnCapture = { count: 0 }

  const { server } = await createMcpServer({
    specs: [],
    name: "main",
    version: "0",
  })
  registerSessionTools(server, {
      workspace: process.cwd(),
    registry,
    resolveAgentAdapter: makeResolver(capture),
    buildOrchestratorMcp: injector,
  })

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)

  return {
    client,
    scopeTokens,
    sessionEvents,
    capture,
    close: async () => {
      await client.close()
    },
  }
}

/** Parse the JSON descriptor the tool returns. */
function descFromResult(result: unknown): { id: string } {
  const content = (result as { content: Array<{ text: string }> }).content
  return JSON.parse(content[0]!.text) as { id: string }
}

/** Pull the scoped `agentproto` entry + its `?scope=` token out of the
 *  forwarded mcpServers list. */
function scopedEntry(mcpServers?: AcpMcpServer[]): {
  entry: AcpMcpServer
  token: string
} {
  const entry = (mcpServers ?? []).find(s => s.name === "agentproto")
  expect(entry, "scoped agentproto entry present").toBeDefined()
  expect(entry!.transport).toBe("http")
  const ref = entry!.ref ?? ""
  expect(ref).toContain(`http://127.0.0.1:${PORT}/mcp/orchestrator`)
  const token = new URL(ref).searchParams.get("scope")
  expect(token, "scope token in URL").toBeTruthy()
  return { entry: entry!, token: token! }
}

describe("agent_start — orchestrator auto-injection (WP3)", () => {
  it("(a) orchestrator:true injects a scoped agentproto entry with a verifiable token", async () => {
    const h = await harness()
    try {
      await h.client.callTool({
        name: "agent_start",
        arguments: { adapter: "claude-code", cwd: "/tmp", orchestrator: true },
      })
      const { token } = scopedEntry(h.capture.mcpServers)
      const scope = h.scopeTokens.verify(token)
      expect(scope, "token resolves in the registry").not.toBeNull()
      // Default `true` → the full curated subset.
      expect([...scope!.tools].sort()).toEqual(
        [...DEFAULT_ORCHESTRATOR_TOOLS].sort(),
      )
    } finally {
      await h.close()
    }
  })

  it("(b) orchestrator:{tools:[...]} narrows the minted token ⊆ default", async () => {
    const h = await harness()
    try {
      // One legit tool + one danger tool + one phantom — only the legit
      // one may survive in the minted scope.
      await h.client.callTool({
        name: "agent_start",
        arguments: {
          adapter: "claude-code",
          cwd: "/tmp",
          orchestrator: {
            tools: ["agent_start", "command_execute", "made_up"],
          },
        },
      })
      const { token } = scopedEntry(h.capture.mcpServers)
      const scope = h.scopeTokens.verify(token)
      expect(scope).not.toBeNull()
      expect([...scope!.tools]).toEqual(["agent_start"])
      expect(scope!.tools.has("command_execute")).toBe(false)
      expect(scope!.tools.has("made_up")).toBe(false)
    } finally {
      await h.close()
    }
  })

  it("(c) caller mcpServers (WP1) and the injected scoped entry coexist", async () => {
    const h = await harness()
    try {
      await h.client.callTool({
        name: "agent_start",
        arguments: {
          adapter: "claude-code",
          cwd: "/tmp",
          mcpServers: [
            { name: "caller-tool", transport: "stdio", ref: "echo hi" },
          ],
          orchestrator: true,
        },
      })
      const servers = h.capture.mcpServers ?? []
      const names = servers.map(s => s.name).sort()
      expect(names).toEqual(["agentproto", "caller-tool"])
      // The caller's entry is forwarded verbatim, untouched.
      const caller = servers.find(s => s.name === "caller-tool")!
      expect(caller.transport).toBe("stdio")
      expect(caller.ref).toBe("echo hi")
      // And the scoped one is still verifiable.
      const { token } = scopedEntry(servers)
      expect(h.scopeTokens.verify(token)).not.toBeNull()
    } finally {
      await h.close()
    }
  })

  it("(d) the scope-token is revoked when the child session exits", async () => {
    const h = await harness()
    try {
      const result = await h.client.callTool({
        name: "agent_start",
        arguments: { adapter: "claude-code", cwd: "/tmp", orchestrator: true },
      })
      const { id } = descFromResult(result)
      const { token } = scopedEntry(h.capture.mcpServers)
      // Live before exit.
      expect(h.scopeTokens.verify(token)).not.toBeNull()
      // Drive the lifecycle: emit session:exited for THIS session id.
      h.sessionEvents.emit({
        type: "session:exited",
        sessionId: id,
        status: "exited",
        ts: new Date().toISOString(),
      })
      // Token must be gone — no leak past the session's life.
      expect(h.scopeTokens.verify(token)).toBeNull()
    } finally {
      await h.close()
    }
  })

  it("(d') an exit for a DIFFERENT session does not revoke the token", async () => {
    const h = await harness()
    try {
      await h.client.callTool({
        name: "agent_start",
        arguments: { adapter: "claude-code", cwd: "/tmp", orchestrator: true },
      })
      const { token } = scopedEntry(h.capture.mcpServers)
      h.sessionEvents.emit({
        type: "session:exited",
        sessionId: "some-other-session",
        status: "exited",
        ts: new Date().toISOString(),
      })
      expect(h.scopeTokens.verify(token)).not.toBeNull()
    } finally {
      await h.close()
    }
  })

  it("no orchestrator field → no scoped entry injected", async () => {
    const h = await harness()
    try {
      await h.client.callTool({
        name: "agent_start",
        arguments: { adapter: "claude-code", cwd: "/tmp" },
      })
      const servers = h.capture.mcpServers ?? []
      expect(servers.find(s => s.name === "agentproto")).toBeUndefined()
    } finally {
      await h.close()
    }
  })
})
