/**
 * `session_list`'s default-view semantics around `kind:"command"` rows.
 * Commands are a shell-execution LOG (already reachable via `command_list` /
 * an explicit `kind:"command"` filter), not resumable sessions — they must
 * stay OUT of the default (`kind` unset or `"all"`) view so they don't bury
 * real agent-cli/terminal rows, while remaining fully reachable via
 * `kind:"command"` or the `includeCommands` union opt-in. Mirrors
 * session-archive-mcp.test.ts's harness.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent, SessionsRegistry } from "../sessions.js"

let acpCounter = 0
function fakeAgentSession(prefix: string): AgentSessionLike {
  return {
    sessionId: `${prefix}_${acpCounter++}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      await new Promise(() => {}) // never resolves — keeps the session "running"
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
  const registry = createSessionsRegistry({ persist: false })
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  registerSessionTools(server, { registry, workspace: process.cwd() })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)

  return { client, registry, close: () => client.close() }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolJson(result: any): { sessions: Array<{ id: string; kind: string }> } {
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}"
  return JSON.parse(text)
}

describe("session_list — kind:\"command\" default-view exclusion", () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "session-list-commands-"))
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it("excludes commands from the default (kind unset) view", async () => {
    const { client, registry, close } = await buildHarness()
    const agentDesc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: workspace,
      agentSession: fakeAgentSession("agent"),
      adapterSlug: "fake",
    })
    const cmdDesc = registry.recordCommand({
      workspaceSlug: "default",
      cwd: workspace,
      command: "pnpm",
      args: ["test"],
      exitCode: 0,
      signal: null,
      durationMs: 5,
      stdout: "",
      stderr: "",
    })

    const result = await client.callTool({ name: "session_list", arguments: {} })
    const { sessions } = toolJson(result)
    const ids = sessions.map(s => s.id)
    expect(ids).toContain(agentDesc.id)
    expect(ids).not.toContain(cmdDesc.id)

    await close()
    registry.shutdown()
  })

  it("excludes commands from the explicit kind:\"all\" view", async () => {
    const { client, registry, close } = await buildHarness()
    const agentDesc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: workspace,
      agentSession: fakeAgentSession("agent"),
      adapterSlug: "fake",
    })
    const cmdDesc = registry.recordCommand({
      workspaceSlug: "default",
      cwd: workspace,
      command: "pnpm",
      args: ["test"],
      exitCode: 0,
      signal: null,
      durationMs: 5,
      stdout: "",
      stderr: "",
    })

    const result = await client.callTool({ name: "session_list", arguments: { kind: "all" } })
    const { sessions } = toolJson(result)
    const ids = sessions.map(s => s.id)
    expect(ids).toContain(agentDesc.id)
    expect(ids).not.toContain(cmdDesc.id)

    await close()
    registry.shutdown()
  })

  it("still returns commands when kind:\"command\" is requested explicitly", async () => {
    const { client, registry, close } = await buildHarness()
    registry.spawnAgent({
      workspaceSlug: "default",
      cwd: workspace,
      agentSession: fakeAgentSession("agent"),
      adapterSlug: "fake",
    })
    const cmdDesc = registry.recordCommand({
      workspaceSlug: "default",
      cwd: workspace,
      command: "pnpm",
      args: ["test"],
      exitCode: 0,
      signal: null,
      durationMs: 5,
      stdout: "",
      stderr: "",
    })

    const result = await client.callTool({ name: "session_list", arguments: { kind: "command" } })
    const { sessions } = toolJson(result)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.id).toBe(cmdDesc.id)

    await close()
    registry.shutdown()
  })

  it("unions commands into the default view when includeCommands:true", async () => {
    const { client, registry, close } = await buildHarness()
    const agentDesc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: workspace,
      agentSession: fakeAgentSession("agent"),
      adapterSlug: "fake",
    })
    const cmdDesc = registry.recordCommand({
      workspaceSlug: "default",
      cwd: workspace,
      command: "pnpm",
      args: ["test"],
      exitCode: 0,
      signal: null,
      durationMs: 5,
      stdout: "",
      stderr: "",
    })

    const result = await client.callTool({
      name: "session_list",
      arguments: { includeCommands: true },
    })
    const { sessions } = toolJson(result)
    const ids = sessions.map(s => s.id)
    expect(ids).toContain(agentDesc.id)
    expect(ids).toContain(cmdDesc.id)

    await close()
    registry.shutdown()
  })

  it("includeCommands has no effect when kind is set explicitly", async () => {
    const { client, registry, close } = await buildHarness()
    const agentDesc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: workspace,
      agentSession: fakeAgentSession("agent"),
      adapterSlug: "fake",
    })
    registry.recordCommand({
      workspaceSlug: "default",
      cwd: workspace,
      command: "pnpm",
      args: ["test"],
      exitCode: 0,
      signal: null,
      durationMs: 5,
      stdout: "",
      stderr: "",
    })

    const result = await client.callTool({
      name: "session_list",
      arguments: { kind: "agent-cli", includeCommands: true },
    })
    const { sessions } = toolJson(result)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.id).toBe(agentDesc.id)

    await close()
    registry.shutdown()
  })
})
