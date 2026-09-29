/**
 * MCP surface of the host load report: the `host_load` tool. The collector is
 * injected as a fake service, so nothing here shells out; the wiring under
 * test is the input schema and the arguments handed to the service.
 */

import { describe, it, expect } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"
import type { HostLoadReport, HostLoadService } from "../host-load.js"

const REPORT: HostLoadReport = {
  sampledAt: "2026-01-01T00:00:00.000Z",
  detail: "summary",
  elapsedMs: 12,
  partial: [],
  platform: "linux",
  loadAvg: [1, 1, 1],
  cpuCount: 4,
  loadPerCore: 0.3,
  memory: { totalBytes: 8, freeBytes: 4, availableBytes: 4 },
  disks: [],
  topByCpu: [],
  topByMemory: [],
  warnings: [],
}

interface Call {
  sessionIds: string[]
  opts: Parameters<HostLoadService["report"]>[1]
}

async function harness() {
  const calls: Call[] = []
  const hostLoad: HostLoadService = {
    async report(sessions, opts) {
      calls.push({ sessionIds: sessions.map(s => s.id), opts })
      return { ...REPORT, detail: opts?.detail ?? "summary" }
    },
  }
  const registry = createSessionsRegistry({ persist: false })
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  registerSessionTools(server, { registry, workspace: process.cwd(), hostLoad })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)
  const session: AgentSessionLike = {
    sessionId: "acp-1",
    pid: 4242,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      await new Promise(() => {})
    },
    async cancel() {},
    async close() {},
  }
  const desc = registry.spawnAgent({
    workspaceSlug: "default",
    cwd: "/tmp",
    agentSession: session,
    adapterSlug: "claude-code",
    label: "one",
  })
  return { client, calls, desc, close: async () => client.close() }
}

const textOf = (r: unknown): string => (r as { content: Array<{ text?: string }> }).content[0]?.text ?? "{}"

describe("host_load", () => {
  it("advertises detail, fresh and budgetMs", async () => {
    const h = await harness()
    const { tools } = await h.client.listTools()
    const tool = tools.find(t => t.name === "host_load")!
    expect(Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual([
      "budgetMs",
      "detail",
      "fresh",
    ])
    await h.close()
  })

  it("returns the collector's report for the whole registry", async () => {
    const h = await harness()
    const res = await h.client.callTool({ name: "host_load", arguments: {} })
    const report = JSON.parse(textOf(res)) as HostLoadReport
    expect(report).toMatchObject({ detail: "summary", cpuCount: 4, warnings: [] })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.sessionIds).toEqual([h.desc.id])
    expect(h.calls[0]!.opts).toEqual({})
    await h.close()
  })

  it("forwards detail, fresh and budgetMs (accepting stringified values)", async () => {
    const h = await harness()
    const res = await h.client.callTool({
      name: "host_load",
      arguments: { detail: "full", fresh: "true", budgetMs: "8000" },
    })
    expect(JSON.parse(textOf(res)).detail).toBe("full")
    expect(h.calls[0]!.opts).toEqual({ detail: "full", fresh: true, budgetMs: 8000 })
    await h.close()
  })

  it("rejects an unknown detail and an out-of-range budget without sampling", async () => {
    const h = await harness()
    const bad = await h.client.callTool({ name: "host_load", arguments: { detail: "everything" } }).catch(e => e)
    const tiny = await h.client.callTool({ name: "host_load", arguments: { budgetMs: 5 } }).catch(e => e)
    const failed = (r: unknown): boolean => r instanceof Error || (r as { isError?: boolean }).isError === true
    expect(failed(bad)).toBe(true)
    expect(failed(tiny)).toBe(true)
    expect(h.calls).toHaveLength(0)
    await h.close()
  })
})
