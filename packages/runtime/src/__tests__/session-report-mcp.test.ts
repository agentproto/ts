/**
 * MCP surface of the fleet-wide session report: `sessions_report` wires
 * `buildSessionReportFromRegistry` onto a real registry over a real MCP
 * transport. The collection/reduction contracts themselves are covered by
 * session-report.test.ts (pure) and session-report-service.test.ts
 * (collector) — this only proves the tool is registered correctly end to
 * end: default window, keepAlive → permanentAgents, input schema shape.
 */
import { describe, it, expect } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"

function fakeAgentSession(pid: number): AgentSessionLike {
  return {
    sessionId: `acp-${pid}`,
    pid,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      await new Promise(() => {})
    },
    async cancel() {},
    async close() {},
  }
}

async function harness() {
  const registry = createSessionsRegistry({ persist: false })
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  registerSessionTools(server, { registry, workspace: process.cwd() })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)
  const standing = registry.spawnAgent({
    workspaceSlug: "default",
    cwd: "/tmp",
    agentSession: fakeAgentSession(4242),
    adapterSlug: "claude-code",
    harness: "claude-code",
    label: "standing-agent",
  })
  registry.setKeepAlive(standing.id, true)
  const ephemeral = registry.spawnAgent({
    workspaceSlug: "default",
    cwd: "/tmp",
    agentSession: fakeAgentSession(4300),
    adapterSlug: "codex",
    harness: "codex",
    label: "one-shot",
  })
  return { client, registry, standing, ephemeral, close: async () => client.close() }
}

const textOf = (r: unknown): string =>
  (r as { content: Array<{ text?: string }> }).content[0]?.text ?? "{}"

describe("sessions_report", () => {
  it("advertises its input schema", async () => {
    const h = await harness()
    const { tools } = await h.client.listTools()
    const schema = tools.find(t => t.name === "sessions_report")!.inputSchema as {
      properties: Record<string, unknown>
    }
    expect(Object.keys(schema.properties).sort()).toEqual(["since", "topN"])
    await h.close()
  })

  it("defaults to a 12h window and counts both freshly-spawned sessions", async () => {
    const h = await harness()
    const res = await h.client.callTool({ name: "sessions_report", arguments: {} })
    const report = JSON.parse(textOf(res)) as {
      since: string
      totalSessions: number
      byHarness: Array<{ key: string; count: number }>
      activeSessions: Array<{ id: string }>
      permanentAgents: Array<{ id: string }>
    }
    expect(report.since).toBe("12h")
    expect(report.totalSessions).toBe(2)
    expect(report.byHarness.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: "claude-code", count: 1 },
      { key: "codex", count: 1 },
    ])
    expect(report.activeSessions.map(s => s.id).sort()).toEqual([h.ephemeral.id, h.standing.id].sort())
    expect(report.permanentAgents.map(s => s.id)).toEqual([h.standing.id])
    await h.close()
  })

  it("rejects an unparseable --since", async () => {
    const h = await harness()
    const res = await h.client.callTool({ name: "sessions_report", arguments: { since: "not-a-window" } })
    expect((res as { isError?: boolean }).isError).toBe(true)
    await h.close()
  })
})
