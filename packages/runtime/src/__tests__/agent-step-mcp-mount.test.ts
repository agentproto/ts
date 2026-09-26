/**
 * A workflow `kind:"agent"` step's session gets the daemon's `/mcp` gateway
 * mounted, scoped to its agent's declared AGENT.md `tools:` — the fix for the
 * repo-maintenance reviewer that could never reach `branch_gc_verdict`
 * because `SessionsRegistryAgentHost.spawn`'s host path passed no
 * `mcpServers` at all.
 *
 * End to end at the spawn-options level: compile a workflow whose agent ref
 * declares tools, run it through the REAL `SessionsRegistryAgentHost` against
 * a fake adapter that captures `startSession`'s `mcpServers`, then connect an
 * MCP client to the captured URL on a live `startHttpServer` whose factory
 * applies the same `?allowTools=` wrap the daemon's does — and check what the
 * child could actually call.
 */

import { describe, it, expect, vi } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createMcpServer } from "@agentproto/mcp-server"
import { compileWorkflow, runWorkflow, type AgentRefResolution } from "@agentproto/workflow-runtime"
import type { WorkflowHandle } from "@agentproto/workflow"
import type { AcpMcpServer } from "@agentproto/acp"

import { startHttpServer } from "../http-server.js"
import { withToolSubset } from "../tool-subset.js"
import { createRuntimeEvents } from "../events.js"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { SessionsRegistryAgentHost, agentStepMcpServers } from "../sessions-registry-agent-host.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

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

// Stand-in for the daemon's mcpServerFactory (index.ts): a probe tool set,
// with the SAME `withToolSubset` wrap the real factory applies for
// `?allowTools=`.
async function mcpServerFactory(
  _denyTools?: ReadonlySet<string>,
  _callerSessionId?: string,
  _origin?: string,
  _deferred?: boolean,
  allowTools?: ReadonlySet<string>,
) {
  const { server: rawServer } = await createMcpServer({ specs: [], name: "main", version: "0" })
  const server = allowTools && allowTools.size > 0 ? withToolSubset(rawServer, allowTools) : rawServer
  for (const name of ["branch_gc_verdict", "branch_gc", "agent_start", "command_execute"]) {
    server.tool(name, `probe ${name}`, {}, async () => ({ content: [{ type: "text", text: `called ${name}` }] }))
  }
  return server
}

function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: "acp_test",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

function reviewWorkflow(): WorkflowHandle {
  return {
    id: "wf",
    name: "wf",
    steps: [{ id: "review", kind: "agent", agent: { ref: "@app/reviewer" }, prompt: "review it" }],
  } as unknown as WorkflowHandle
}

/** Compile + run the one-step workflow through the real host; return the
 *  `mcpServers` the step's session was started with. */
async function spawnStep(ref: AgentRefResolution, daemonMcpUrl: string): Promise<AcpMcpServer[] | undefined> {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const startSession = vi.fn(async (_opts: Record<string, unknown>) => fakeAgentSession())
  const resolveAgentAdapter: AgentAdapterResolver = vi.fn(async () => ({ startSession, commandPreview: "fake" }))
  const host = new SessionsRegistryAgentHost(registry, sessionEvents, resolveAgentAdapter, { daemonMcpUrl })
  // The turn itself is irrelevant here — only the spawn options are under test.
  host.sendPromptAndWait = vi.fn(async () => {})
  const compiled = compileWorkflow(reviewWorkflow(), {
    tools: {},
    candidates: [],
    agentRefs: { "@app/reviewer": ref },
  })
  await runWorkflow({ workflow: compiled, agents: host, input: {} })
  expect(startSession).toHaveBeenCalledTimes(1)
  return startSession.mock.calls[0]![0].mcpServers as AcpMcpServer[] | undefined
}

async function toolsReachableAt(ref: string): Promise<string[]> {
  const client = new Client({ name: "agent-step-mount-test", version: "0.0.1" })
  await client.connect(new StreamableHTTPClientTransport(new URL(ref)))
  try {
    const { tools } = await client.listTools()
    return tools.map(t => t.name).sort()
  } finally {
    await client.close()
  }
}

describe("workflow agent step — daemon gateway mount scoped to AGENT.md tools", () => {
  it("an agent that declares a daemon tool can call it; undeclared daemon tools are not mounted", async () => {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const daemonMcpUrl = `http://127.0.0.1:${port}/mcp`
      const mcpServers = await spawnStep(
        {
          // Not a default-self-mount adapter — the declared tools alone earn the mount.
          adapter: "mastra-agent",
          tools: ["run_command", "read_file", "branch_gc_verdict"],
        },
        daemonMcpUrl,
      )
      expect(mcpServers).toHaveLength(1)
      const ref = mcpServers![0]!.ref as string
      expect(ref.startsWith(`${daemonMcpUrl}?`)).toBe(true)
      expect(ref).toContain("callerSessionId=")
      // Only the declared daemon tool is reachable — harness-native names
      // (run_command/read_file) match nothing on the gateway.
      expect(await toolsReachableAt(ref)).toEqual(["branch_gc_verdict"])

      const client = new Client({ name: "agent-step-mount-call", version: "0.0.1" })
      await client.connect(new StreamableHTTPClientTransport(new URL(ref)))
      const res = await client.callTool({ name: "branch_gc_verdict", arguments: {} })
      expect(res.content).toEqual([{ type: "text", text: "called branch_gc_verdict" }])
      await client.close()
    } finally {
      await http.stop()
    }
  })

  it("an agent whose tools list omits the daemon tool cannot reach it", async () => {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const daemonMcpUrl = `http://127.0.0.1:${port}/mcp`
      const mcpServers = await spawnStep(
        { adapter: "claude-code", tools: ["run_command", "branch_gc"] },
        daemonMcpUrl,
      )
      const ref = mcpServers![0]!.ref as string
      const reachable = await toolsReachableAt(ref)
      expect(reachable).toEqual(["branch_gc"])
      expect(reachable).not.toContain("branch_gc_verdict")
    } finally {
      await http.stop()
    }
  })
})

describe("agentStepMcpServers", () => {
  const url = "http://127.0.0.1:1/mcp"

  it("scopes to the declared tools for any adapter, forcing deferred loading off", () => {
    const [entry] = agentStepMcpServers({ adapter: "codex", daemonMcpUrl: url, sessionId: "sess_1", agentTools: ["a", "b"] })!
    expect(entry!.name).toBe("agentproto")
    const q = new URL(entry!.ref as string).searchParams
    expect(q.get("allowTools")).toBe("a,b")
    expect(q.get("deferred")).toBe("0")
    expect(q.get("callerSessionId")).toBe("sess_1")
  })

  it("with no declared tools, follows agent_start's default self-mount (claude-code yes, codex no)", () => {
    const cc = agentStepMcpServers({ adapter: "claude-code", daemonMcpUrl: url, sessionId: "sess_2" })!
    const q = new URL(cc[0]!.ref as string).searchParams
    expect(q.get("allowTools")).toBeNull()
    expect(q.get("callerSessionId")).toBe("sess_2")
    expect(agentStepMcpServers({ adapter: "codex", daemonMcpUrl: url, sessionId: "sess_3" })).toBeUndefined()
  })

  it("mounts nothing without a daemon URL", () => {
    expect(
      agentStepMcpServers({ adapter: "claude-code", daemonMcpUrl: undefined, sessionId: "s", agentTools: ["a"] }),
    ).toBeUndefined()
  })
})
