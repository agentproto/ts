/**
 * Unit tests for the `session_archive` / `session_unarchive` MCP tools
 * (session-tools.ts) — the ingress layer over `SessionsRegistry.archiveSession`
 * /`unarchiveSession` (registry-level guard/persist behaviour is covered in
 * session-archive.test.ts). Mirrors session-restart.test.ts's harness.
 */

import { describe, it, expect } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { AgentSessionLike, AgentStreamEvent, SessionsRegistry } from "../sessions.js"

let acpCounter = 0
function fakeAgentSession(prefix: string): AgentSessionLike {
  return {
    sessionId: `${prefix}_${acpCounter++}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

async function buildHarness(): Promise<{
  client: Client
  registry: SessionsRegistry
  close: () => Promise<void>
}> {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  registerSessionTools(server, { registry })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)

  return { client, registry, close: () => client.close() }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolJson(result: any): Record<string, unknown> {
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}"
  return JSON.parse(text)
}

describe("session_archive", () => {
  it("refuses a still-alive session with a clear error", async () => {
    const { client, registry, close } = await buildHarness()
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("claude"),
      adapterSlug: "claude-code",
    })

    const result = await client.callTool({
      name: "session_archive",
      arguments: { idOrName: prev.id },
    })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ""
    expect(text).toMatch(/still running/)
    expect(registry.get(prev.id)?.archived).not.toBe(true)

    await close()
    registry.shutdown()
  })

  it("archives a terminal session and hides it from session_list's default view", async () => {
    const { client, registry, close } = await buildHarness()
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("claude"),
      adapterSlug: "claude-code",
    })
    registry.kill(prev.id)

    const result = await client.callTool({
      name: "session_archive",
      arguments: { idOrName: prev.id },
    })
    expect(result.isError).toBeFalsy()
    expect(toolJson(result).archived).toBe(true)

    const listed = await client.callTool({ name: "session_list", arguments: {} })
    const rows = toolJson(listed).sessions as Array<{ id: string }>
    expect(rows.some(s => s.id === prev.id)).toBe(false)

    const listedAll = await client.callTool({
      name: "session_list",
      arguments: { includeArchived: true },
    })
    const rowsAll = toolJson(listedAll).sessions as Array<{ id: string }>
    expect(rowsAll.some(s => s.id === prev.id)).toBe(true)

    await close()
    registry.shutdown()
  })

  it("errors on an unknown session id", async () => {
    const { client, close, registry } = await buildHarness()
    const result = await client.callTool({
      name: "session_archive",
      arguments: { idOrName: "sess_nope" },
    })
    expect(result.isError).toBe(true)
    await close()
    registry.shutdown()
  })
})

describe("session_unarchive", () => {
  it("restores default-list visibility for an archived session", async () => {
    const { client, registry, close } = await buildHarness()
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("claude"),
      adapterSlug: "claude-code",
    })
    registry.kill(prev.id)
    registry.archiveSession(prev.id)

    const result = await client.callTool({
      name: "session_unarchive",
      arguments: { idOrName: prev.id },
    })
    expect(result.isError).toBeFalsy()
    expect(toolJson(result).archived).toBe(false)

    const listed = await client.callTool({ name: "session_list", arguments: {} })
    const rows = toolJson(listed).sessions as Array<{ id: string }>
    expect(rows.some(s => s.id === prev.id)).toBe(true)

    await close()
    registry.shutdown()
  })
})
