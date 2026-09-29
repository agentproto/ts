/**
 * MCP surface of the per-session resource sampler: `session_list` /
 * `agent_sessions_list` accept `stats: true | "full"`, and the dedicated
 * `session_stats` tool returns the labelled report. The sampler is injected
 * with a fake process table, so nothing here shells out to `ps`.
 */

import { describe, it, expect } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerAgentTools } from "../agent-tools.js"
import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"
import {
  createProcessStatsService,
  createProvisionTracker,
  type HostInfo,
  type ProcRow,
} from "../process-stats.js"

const HOST: HostInfo = {
  platform: "linux",
  cpuCount: 4,
  loadAvg: [0.5, 0.4, 0.3],
  totalMemBytes: 8 * 1024 ** 3,
  freeMemBytes: 2 * 1024 ** 3,
}

const proc = (pid: number, ppid: number, args: string, rssKib: number): ProcRow => ({
  pid,
  ppid,
  uid: 501,
  rssKib,
  cpuPercent: 2,
  elapsedSec: 120,
  args,
})

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
  const processStats = createProcessStatsService({
    table: async () => [
      proc(1, 0, "/sbin/init", 100),
      proc(100, 1, "node daemon.js", 5000),
      proc(4242, 100, "claude", 2000),
      proc(4243, 4242, "node /r/node_modules/vitest/dist/workers/forks.js", 8000),
      proc(4300, 100, "claude", 1000),
    ],
    host: async () => HOST,
    envHints: async () => new Map(),
    tracker: createProvisionTracker(),
    daemonPid: 100,
    uid: 501,
  })
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  registerSessionTools(server, { registry, workspace: process.cwd(), processStats })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)
  const big = registry.spawnAgent({
    workspaceSlug: "default",
    cwd: "/tmp",
    agentSession: fakeAgentSession(4242),
    adapterSlug: "claude-code",
    label: "big-one",
  })
  const small = registry.spawnAgent({
    workspaceSlug: "default",
    cwd: "/tmp",
    agentSession: fakeAgentSession(4300),
    adapterSlug: "claude-code",
    label: "small-one",
  })
  return { client, registry, big, small, close: async () => client.close() }
}

const textOf = (r: unknown): string =>
  (r as { content: Array<{ text?: string }> }).content[0]?.text ?? "{}"

describe("stats input schema", () => {
  it("session_list and session_stats advertise their stats params", async () => {
    const h = await harness()
    const { tools } = await h.client.listTools()
    const props = (name: string) =>
      (tools.find(t => t.name === name)!.inputSchema as { properties: Record<string, unknown> }).properties

    expect(props("session_list")).toHaveProperty("stats")
    expect(Object.keys(props("session_stats")).sort()).toEqual(["detail", "fresh"])
    await h.close()
  })

  it("agent_sessions_list advertises stats", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { server } = await createMcpServer({ specs: [], name: "agents", version: "0" })
    registerAgentTools(server, { registry })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "test-client", version: "0" })
    await client.connect(clientTransport)
    const { tools } = await client.listTools()
    const schema = tools.find(t => t.name === "agent_sessions_list")!.inputSchema as {
      properties: Record<string, unknown>
    }
    expect(schema.properties).toHaveProperty("stats")
    await client.close()
    registry.shutdown()
  })
})

describe("session_list stats", () => {
  it("omits stats unless asked", async () => {
    const h = await harness()
    const res = await h.client.callTool({ name: "session_list", arguments: { full: true } })
    const rows = JSON.parse(textOf(res)).sessions as Array<{ stats?: unknown }>
    expect(rows.every(r => r.stats === undefined)).toBe(true)
    await h.close()
  })

  it("stamps a measured process tree on each live row when stats:true", async () => {
    const h = await harness()
    const res = await h.client.callTool({ name: "session_list", arguments: { full: true, stats: true } })
    const rows = JSON.parse(textOf(res)).sessions as Array<{
      id: string
      stats?: { rssBytes: number; procCount: number; pid: number; processes?: unknown }
    }>
    const row = rows.find(r => r.id === h.big.id)!
    expect(row.stats).toMatchObject({ pid: 4242, procCount: 2, rssBytes: 10_000 * 1024 })
    expect(row.stats!.processes).toBeUndefined()
    await h.close()
  })

  it("accepts the string 'true' and adds per-process detail for stats:'full'", async () => {
    const h = await harness()
    const str = await h.client.callTool({ name: "session_list", arguments: { full: true, stats: "true" } })
    expect(JSON.parse(textOf(str)).sessions.some((r: { stats?: unknown }) => r.stats)).toBe(true)

    const full = await h.client.callTool({ name: "session_list", arguments: { full: true, stats: "full" } })
    const row = (
      JSON.parse(textOf(full)).sessions as Array<{ id: string; stats?: { processes?: Array<{ command: string }> } }>
    ).find(r => r.id === h.big.id)!
    expect(row.stats!.processes!.map(p => p.command)).toEqual(["vitest", "claude"])
    await h.close()
  })
})

describe("session_stats", () => {
  it("returns labelled rows sorted by RSS with daemon, provisioning, orphans, totals and host", async () => {
    const h = await harness()
    const res = await h.client.callTool({ name: "session_stats", arguments: {} })
    const report = JSON.parse(textOf(res)) as {
      host: HostInfo
      sessions: Array<{ sessionId: string; label?: string; rssBytes: number }>
      daemon: { pid: number; procCount: number }
      provisioning: { inFlight: unknown[] }
      orphans: unknown[]
      totals: { rssBytes: number; procCount: number }
    }
    expect(report.host.cpuCount).toBe(4)
    expect(report.sessions.map(s => [s.sessionId, s.label])).toEqual([
      [h.big.id, "big-one"],
      [h.small.id, "small-one"],
    ])
    expect(report.daemon).toMatchObject({ pid: 100, procCount: 1 })
    expect(report.provisioning.inFlight).toEqual([])
    expect(report.orphans).toEqual([])
    expect(report.totals).toMatchObject({ rssBytes: (5000 + 10_000 + 1000) * 1024, procCount: 4 })
    await h.close()
  })

  it("detail:'full' lists every process", async () => {
    const h = await harness()
    const res = await h.client.callTool({ name: "session_stats", arguments: { detail: "full" } })
    const report = JSON.parse(textOf(res)) as { sessions: Array<{ processes?: Array<{ pid: number }> }> }
    expect(report.sessions[0]!.processes!.map(p => p.pid)).toEqual([4243, 4242])
    await h.close()
  })

  it("rejects an unknown detail level", async () => {
    const h = await harness()
    const res = await h.client.callTool({ name: "session_stats", arguments: { detail: "everything" } })
    expect((res as { isError?: boolean }).isError).toBe(true)
    await h.close()
  })
})
