/**
 * Unit + MCP-transport coverage for the `app_*` verbs (app-tools.ts).
 * Mirrors workflow-mcp-e2e.test.ts's real-McpServer + InMemoryTransport
 * setup and agent-start-mode.test.ts's session-spawn seam (a fake
 * `AgentAdapterResolver` over a real `createSessionsRegistry`) — no heavy
 * mocking of providers-store/workspaces-config/auth needed, same as those.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { defineApp } from "@agentproto/app-kit"
import { defineAgent } from "@agentproto/agent"
import { defineWorkflow } from "@agentproto/workflow"
import { registerAppTools } from "../app-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

function parseToolJson(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string; isError?: boolean }> })
    .content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}
function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true
}

async function buildFixtureApp(dir: string, opts: { toolId: string }) {
  const app = defineApp({
    id: "@test/fixture-app",
    name: "Fixture App",
    agents: [
      {
        agent: defineAgent({
          schema: "agent/v1",
          id: "worker",
          description: "A worker agent.",
          model: "claude-sonnet-5",
          workflows: [{ ref: "do-thing" }],
        }),
        body: "You do the thing.",
      },
    ],
    workflows: [
      defineWorkflow({
        id: "do-thing",
        name: "Do thing",
        description: "Does a thing.",
        version: "0.1.0",
        inputs: {},
        outputs: {},
        steps: [{ id: "step1", kind: "tool", tool: opts.toolId }],
      }),
    ],
  })
  await app.emit(dir)
}

function fakeStartSession() {
  return vi.fn(async (_opts: Record<string, unknown>) => ({
    sessionId: "adapter_app_run_test",
    send: async function* () {},
    cancel: async () => {},
    close: async () => {},
  }))
}

async function setup(opts: {
  listRegisteredToolIds?: () => Promise<string[]>
  resolveAgentAdapter?: AgentAdapterResolver | null
  startSession?: ReturnType<typeof fakeStartSession>
} = {}) {
  const registry = createSessionsRegistry({ persist: false })
  const startSession = opts.startSession ?? fakeStartSession()
  const resolveAgentAdapter: AgentAdapterResolver | undefined =
    opts.resolveAgentAdapter === null
      ? undefined
      : opts.resolveAgentAdapter ??
        (async (slug: string) =>
          slug === "mastra-agent" ? { startSession, commandPreview: "mock-adapter" } : null)
  const listRegisteredToolIds = opts.listRegisteredToolIds ?? (async () => ["known_tool"])

  const server = new McpServer({ name: "app-tools-test-server", version: "0.0.0" })
  registerAppTools(server, {
    registry,
    listRegisteredToolIds,
    ...(resolveAgentAdapter ? { resolveAgentAdapter } : {}),
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "app-tools-test-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return { client, registry, startSession }
}

describe("app_* verbs", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "app-tools-test-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("app_install: happy path persists an installed-app record", async () => {
    await buildFixtureApp(dir, { toolId: "known_tool" })
    const { client } = await setup()

    const res = await client.callTool({ name: "app_install", arguments: { dir } })
    expect(isError(res)).toBe(false)
    const record = parseToolJson(res)
    expect(record.appId).toBe("@test/fixture-app")
    expect(record.agents).toEqual([{ id: "worker", path: expect.stringContaining("AGENT.md") }])
    expect(record.workflows).toEqual([{ id: "do-thing", path: expect.stringContaining("WORKFLOW.md") }])
    expect(record.unvalidatedAgentTools).toEqual([])
  })

  it("app_install: a bogus workflow tool id lists ALL missing ids in one error, not one at a time", async () => {
    await buildFixtureApp(dir, { toolId: "totally_bogus_tool_xyz" })
    const { client } = await setup({ listRegisteredToolIds: async () => ["known_tool"] })

    const res = await client.callTool({ name: "app_install", arguments: { dir } })
    expect(isError(res)).toBe(true)
    const body = parseToolJson(res)
    expect(body.error).toContain("totally_bogus_tool_xyz")
  })

  it("app_install: adapter not resolvable fails with an actionable hint", async () => {
    await buildFixtureApp(dir, { toolId: "known_tool" })
    const { client } = await setup({ resolveAgentAdapter: async () => null })

    const res = await client.callTool({ name: "app_install", arguments: { dir } })
    expect(isError(res)).toBe(true)
    const body = parseToolJson(res)
    expect(body.error).toContain("agentproto install mastra-agent")
  })

  it("app_list reflects the install; re-install upserts instead of duplicating", async () => {
    await buildFixtureApp(dir, { toolId: "known_tool" })
    const { client } = await setup()

    await client.callTool({ name: "app_install", arguments: { dir } })
    await client.callTool({ name: "app_install", arguments: { dir } })

    const apps = parseToolJson(await client.callTool({ name: "app_list", arguments: {} }))
    expect(apps).toHaveLength(1)
    expect(apps[0].appId).toBe("@test/fixture-app")
    expect(apps[0].runs).toEqual([])
  })

  it("app_run spawns a session per agent (stubbed spawn), app_status reports it, app_stop kills it", async () => {
    await buildFixtureApp(dir, { toolId: "known_tool" })
    const { client, registry, startSession } = await setup()

    await client.callTool({ name: "app_install", arguments: { dir } })

    const ran = parseToolJson(
      await client.callTool({ name: "app_run", arguments: { appId: "@test/fixture-app" } }),
    )
    expect(ran.appRunId).toMatch(/^apprun_/)
    expect(ran.sessions).toEqual([{ agentId: "worker", sessionId: expect.stringMatching(/^sess_/) }])
    expect(startSession).toHaveBeenCalledTimes(1)
    const spawnOpts = startSession.mock.calls[0]![0]
    expect(spawnOpts.options).toEqual({ agent: expect.stringContaining("AGENT.md") })

    const sessionId = ran.sessions[0].sessionId
    expect(registry.get(sessionId)?.status).toBe("running")

    const status = parseToolJson(
      await client.callTool({ name: "app_status", arguments: { appRunId: ran.appRunId } }),
    )
    expect(status.status).toBe("running")
    expect(status.sessions).toEqual([
      { agentId: "worker", sessionId, descriptor: expect.objectContaining({ id: sessionId }) },
    ])

    const stopped = parseToolJson(
      await client.callTool({ name: "app_stop", arguments: { appRunId: ran.appRunId } }),
    )
    expect(stopped.killed).toEqual([sessionId])
    expect(stopped.status).toBe("stopped")
    expect(registry.get(sessionId)?.status).toBe("killed")
  })

  it("app_run rejects an unknown agent id", async () => {
    await buildFixtureApp(dir, { toolId: "known_tool" })
    const { client } = await setup()
    await client.callTool({ name: "app_install", arguments: { dir } })

    const res = await client.callTool({
      name: "app_run",
      arguments: { appId: "@test/fixture-app", agents: ["nope"] },
    })
    expect(isError(res)).toBe(true)
    const body = parseToolJson(res)
    expect(body.error).toContain("nope")
  })
})
