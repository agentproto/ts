/**
 * `session_capabilities` MCP tool (`session-tools.ts`) + its shared builder
 * (`session-capabilities.ts`) — see
 * `.plans/session-chat-harness-surfaces/PLAN-A-daemon-capabilities.md` for
 * the frozen contract this exercises. Coverage: ACP vs print arm
 * classification (`commandsSupported` derived from the live protocol arm,
 * never from whether `availableCommands` happens to be non-empty), the
 * mcpServers redaction (`{name, transport, ref}` only — never headers/env/
 * credentialRef), skills surviving a simulated daemon restart with
 * `skillsApplied` true only for hermes, and subtree-scoping denial for a
 * scoped orchestrator caller.
 */

import { describe, it, expect } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import type { OrchestratorScope } from "../orchestrator-gateway.js"
import { buildSessionCapabilities } from "../session-capabilities.js"
import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

let n = 0

/** ACP-arm fixture: only the ACP protocol arm ever wires a `steer` method
 *  onto `AgentSessionLike` (`createAcpProtocolArm`) — that presence is the
 *  signal `stampCapabilities` reads to set `commandsSupported`. */
function fakeAcpAgentSession(): AgentSessionLike {
  return {
    sessionId: `acp_${n++}`,
    availableModes: [
      { id: "default", name: "Default" },
      { id: "plan", name: "Plan" },
    ],
    steeringSupported: true,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
    async steer() {
      return "steered" as const
    },
  }
}

/** print/proprietary-arm fixture: no `steer`, matching
 *  `driver-agent-cli`'s print arm exactly (no live ACP session to steer). */
function fakePrintAgentSession(): AgentSessionLike {
  return {
    sessionId: `print_${n++}`,
    availableModes: [],
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

interface Harness {
  registry: ReturnType<typeof createSessionsRegistry>
  client: Client
  close: () => Promise<void>
}

async function harness(opts?: { callerScope?: OrchestratorScope }): Promise<Harness> {
  const registry = createSessionsRegistry({ persist: false })
  const server = new McpServer({ name: "capabilities-test", version: "0" })
  registerSessionTools(server, {
    registry,
    workspace: process.cwd(),
    ...(opts?.callerScope ? { callerScope: opts.callerScope } : {}),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "capabilities-test-client", version: "0" })
  await client.connect(clientTransport)
  return {
    registry,
    client,
    close: async () => {
      await client.close()
      registry.shutdown()
    },
  }
}

function firstText(result: unknown): string {
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return ""
  const first = content[0]
  return first && typeof first === "object" && "text" in first && typeof first.text === "string"
    ? first.text
    : ""
}

describe("session_capabilities", () => {
  it("ACP session: commands + modes populated, commandsSupported true, arm 'acp'", async () => {
    const { registry, client, close } = await harness()
    try {
      const desc = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: process.cwd(),
        adapterSlug: "claude-code",
        agentSession: fakeAcpAgentSession(),
      })
      // `available-commands` stream events mirror onto this field — set it
      // directly rather than driving a full turn through `send()`.
      desc.availableCommands = [
        { name: "/compact", description: "Compact context", input: { hint: "no args" } },
      ]

      const result = await client.callTool({
        name: "session_capabilities",
        arguments: { sessionId: desc.id },
      })
      expect(result.isError).toBeFalsy()
      const body = JSON.parse(firstText(result))

      expect(body.arm).toBe("acp")
      expect(body.commandsSupported).toBe(true)
      expect(body.commands).toEqual([
        { name: "/compact", description: "Compact context", hint: "no args" },
      ])
      expect(body.availableModes).toEqual([
        { id: "default", name: "Default" },
        { id: "plan", name: "Plan" },
      ])
      expect(body.canonicalPostures).toEqual(
        expect.arrayContaining(["default", "plan", "accept-edits", "bypass", "read-only"]),
      )
      expect(body.adapter).toBe("claude-code")
      expect(body.sessionId).toBe(desc.id)
    } finally {
      await close()
    }
  })

  it("print-arm session: commands empty, commandsSupported false, arm 'print' — not derived from list length", async () => {
    const { registry, client, close } = await harness()
    try {
      const desc = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: process.cwd(),
        adapterSlug: "hermes",
        agentSession: fakePrintAgentSession(),
      })

      const result = await client.callTool({
        name: "session_capabilities",
        arguments: { id: desc.id },
      })
      expect(result.isError).toBeFalsy()
      const body = JSON.parse(firstText(result))

      expect(body.arm).toBe("print")
      expect(body.commandsSupported).toBe(false)
      expect(body.commands).toEqual([])
      expect(body.availableModes).toEqual([])
    } finally {
      await close()
    }
  })

  it("redacts mcpServers to {name, transport, ref} — headers/env/credentialRef never leak", async () => {
    const CANARY = "synthetic-mcp-secret-canary-not-a-real-credential"
    const { registry, client, close } = await harness()
    try {
      const desc = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: process.cwd(),
        adapterSlug: "claude-code",
        agentSession: fakePrintAgentSession(),
        mcpServers: [
          {
            name: "gh",
            transport: "http",
            ref: "https://example.invalid/mcp",
            headers: { Authorization: `Bearer ${CANARY}` },
            env: { TOKEN: CANARY },
            credentialRef: CANARY,
          },
        ],
      })

      const result = await client.callTool({
        name: "session_capabilities",
        arguments: { sessionId: desc.id },
      })
      const text = firstText(result)
      expect(text).not.toContain(CANARY)
      const body = JSON.parse(text)
      expect(body.mcpServers).toEqual([
        { name: "gh", transport: "http", ref: "https://example.invalid/mcp", status: "declared" },
      ])
    } finally {
      await close()
    }
  })

  it("skills: resolved list survives a simulated daemon restart; skillsApplied true only for hermes", () => {
    const tmp = mkdtempSync(join(tmpdir(), "session-capabilities-test-"))
    const persistPath = join(tmp, "sessions.json")
    try {
      // Seed sessions.json as if a previous daemon had written it — the
      // "simulated restart" the plan asks for (same pattern as
      // sessions.test.ts's "threads persisted mcpServers through the resume
      // path").
      writeFileSync(
        persistPath,
        JSON.stringify({
          savedAt: "2026-06-21T00:00:00Z",
          sessions: [
            {
              id: "sess_hermes01",
              kind: "agent-cli",
              workspaceSlug: "default",
              command: "hermes (agent)",
              pid: null,
              status: "running",
              startedAt: "2026-06-21T00:00:00Z",
              adapterSlug: "hermes",
              adapterSessionId: "h1",
              cwd: "/tmp",
              skills: ["agentproto"],
            },
            {
              id: "sess_claude01",
              kind: "agent-cli",
              workspaceSlug: "default",
              command: "claude (agent)",
              pid: null,
              status: "running",
              startedAt: "2026-06-21T00:00:00Z",
              adapterSlug: "claude-code",
              adapterSessionId: "c1",
              cwd: "/tmp",
              skills: ["agentproto"],
            },
          ],
        }),
      )

      const registry = createSessionsRegistry({ persistPath })
      try {
        const hermesDesc = registry.get("sess_hermes01")
        const claudeDesc = registry.get("sess_claude01")
        expect(hermesDesc?.skills).toEqual(["agentproto"])
        expect(claudeDesc?.skills).toEqual(["agentproto"])

        const hermesBody = buildSessionCapabilities(hermesDesc!, 0)
        expect(hermesBody.skills).toEqual(["agentproto"])
        expect(hermesBody.skillsApplied).toBe(true)

        const claudeBody = buildSessionCapabilities(claudeDesc!, 0)
        expect(claudeBody.skills).toEqual(["agentproto"])
        expect(claudeBody.skillsApplied).toBe(false)
      } finally {
        registry.shutdown()
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("denies a scoped orchestrator caller a session outside its subtree", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const owner = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      adapterSlug: "claude-code",
      agentSession: fakePrintAgentSession(),
    })
    const outsider = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      adapterSlug: "claude-code",
      agentSession: fakePrintAgentSession(),
    })
    const callerScope: OrchestratorScope = {
      token: "t",
      tools: new Set(["session_capabilities"]),
      ownerSessionId: owner.id,
      depth: 0,
      maxDepth: 5,
      maxChildren: 5,
      role: "supervisor",
    }

    const server = new McpServer({ name: "capabilities-scope-test", version: "0" })
    registerSessionTools(server, { registry, workspace: process.cwd(), callerScope })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "capabilities-scope-test-client", version: "0" })
    await client.connect(clientTransport)

    try {
      const denied = await client.callTool({
        name: "session_capabilities",
        arguments: { sessionId: outsider.id },
      })
      expect(denied.isError).toBe(true)
      expect(firstText(denied)).toContain("orchestrator_session_out_of_scope")

      // Sanity: the owning session itself IS in its own subtree.
      const allowed = await client.callTool({
        name: "session_capabilities",
        arguments: { sessionId: owner.id },
      })
      expect(allowed.isError).toBeFalsy()
    } finally {
      await client.close()
      registry.shutdown()
    }
  })

  it("GET /sessions/:id/capabilities serves the same body as the MCP tool, 404s on an unknown id", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      adapterSlug: "claude-code",
      agentSession: fakeAcpAgentSession(),
    })
    desc.availableCommands = [{ name: "/compact", description: "Compact context" }]

    const port = await new Promise<number>((resolve, reject) => {
      const srv = createServer()
      srv.once("error", reject)
      srv.listen(0, "127.0.0.1", () => {
        const p = (srv.address() as AddressInfo).port
        srv.close(() => resolve(p))
      })
    })
    const conversations: ConversationStore = {
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
    const heartbeat: HeartbeatRunner = { start() {}, stop() {}, async fireNow() {} }
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({
      startSession: async () => fakeAcpAgentSession(),
      commandPreview: "x",
    })
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "t", version: "0" })).server,
      conversations,
      events: createRuntimeEvents(),
      heartbeat,
      sessions: registry,
      resolveAgentAdapter,
      meta: { workspace: process.cwd(), registered: [] },
    })
    const base = `http://127.0.0.1:${port}`
    try {
      const res = await fetch(`${base}/sessions/${desc.id}/capabilities`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body).toEqual(buildSessionCapabilities(registry.get(desc.id)!, 0))
      expect(body.arm).toBe("acp")
      expect(body.commands).toEqual([{ name: "/compact", description: "Compact context" }])

      expect((await fetch(`${base}/sessions/sess_nope/capabilities`)).status).toBe(404)
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })
})
