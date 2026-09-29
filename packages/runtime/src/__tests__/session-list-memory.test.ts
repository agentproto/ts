/**
 * `session_list`'s `withMemory: true` opt-in (FIX-9A part 1) — adds
 * `rssBytes` (process-tree RSS, `process-memory.ts`) to live sessions that
 * have a pid, without ever spawning `ps` unless asked.
 */

import { describe, it, expect } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent, SessionDescriptor } from "../sessions.js"

function fakeAgentSession(pid?: number): AgentSessionLike {
  return {
    sessionId: `acp-${pid ?? "none"}`,
    pid,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      await new Promise(() => {}) // never resolves — keeps the session "running"
    },
    async cancel() {},
    async close() {},
  }
}

async function buildHarness() {
  const registry = createSessionsRegistry({ persist: false })
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  registerSessionTools(server, { registry, workspace: process.cwd() })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)

  return { client, registry, close: () => client.close() }
}

function textOf(result: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (result as any).content[0]?.text ?? "{}"
}

describe("session_list withMemory", () => {
  it("adds rssBytes per live session with a pid when withMemory:true", async () => {
    const { client, registry, close } = await buildHarness()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgentSession(4242),
      adapterSlug: "claude-code",
    })

    // This runs a REAL `ps` (session-tools.ts wires the default executor —
    // there's no seam to inject one through the MCP surface, that's covered
    // in process-memory.test.ts). pid 4242 is almost certainly not a real
    // process on the test box, so `ps` legitimately won't report it — this
    // test only pins the WIRING (the tool passes withMemory through and
    // never throws), not real ps output.
    const res = await client.callTool({ name: "session_list", arguments: { withMemory: true, full: true } })
    const parsed = JSON.parse(textOf(res)) as { sessions: SessionDescriptor[] }
    const row = parsed.sessions.find(s => s.id === desc.id)
    expect(row).toBeDefined()
    if (row?.rssBytes !== undefined) {
      expect(row.rssBytes).toBeGreaterThan(0)
    }

    await close()
    registry.shutdown()
  })

  it("never adds rssBytes when withMemory is omitted", async () => {
    const { client, registry, close } = await buildHarness()
    registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgentSession(4242),
      adapterSlug: "claude-code",
    })

    const res = await client.callTool({ name: "session_list", arguments: { full: true } })
    const parsed = JSON.parse(textOf(res)) as { sessions: SessionDescriptor[] }
    expect(parsed.sessions.every(s => s.rssBytes === undefined)).toBe(true)

    await close()
    registry.shutdown()
  })

  it("is a no-op when no live session has a pid (never spawns ps)", async () => {
    const { client, registry, close } = await buildHarness()
    registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgentSession(undefined),
      adapterSlug: "claude-code",
    })

    const res = await client.callTool({ name: "session_list", arguments: { withMemory: true, full: true } })
    const parsed = JSON.parse(textOf(res)) as { sessions: SessionDescriptor[] }
    expect(parsed.sessions.every(s => s.rssBytes === undefined)).toBe(true)

    await close()
    registry.shutdown()
  })
})
