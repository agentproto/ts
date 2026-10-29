/**
 * AIP-46 §Operator binding on the MCP `agent_start` tool: the spawn records
 * `operator` (+ the host's `operatorDigest`) on the session descriptor, refuses
 * a malformed ref, and gates who may name an operator (rule 4). Also covers the
 * `agentId` / `agentPath` fields the MCP schema now exposes like the HTTP route.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerAgentTools } from "../agent-tools.js"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

function parseToolJson(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}

const fakeSession = (): AgentSessionLike => ({
  sessionId: "adapter_operator_test",
  // eslint-disable-next-line require-yield
  async *send() {},
  async cancel() {},
  async close() {},
})

async function setup(opts: { caller?: { operator?: string; operatorDigest?: string } } = {}) {
  const registry = createSessionsRegistry({ persist: false })
  const startSession = vi.fn(async () => fakeSession())
  const resolveAgentAdapter: AgentAdapterResolver = async () => ({
    startSession: startSession as any,
    commandPreview: "mock-adapter",
  })
  // A session caller is a session already in the registry; its id reaches the
  // tool the way the self-ref `?callerSessionId=` query does.
  const caller = opts.caller
    ? registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: fakeSession(),
        adapterSlug: "mock",
        ...(opts.caller.operator ? { operator: opts.caller.operator } : {}),
        ...(opts.caller.operatorDigest ? { operatorDigest: opts.caller.operatorDigest } : {}),
      })
    : undefined
  const server = new McpServer({ name: "agent-start-operator-server", version: "0.0.0" })
  registerAgentTools(server, {
    registry,
    resolveAgentAdapter,
    ...(caller ? { callerSessionId: caller.id } : {}),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "agent-start-operator-client", version: "0.0.0" })
  await client.connect(clientTransport)
  const start = (args: Record<string, unknown>) =>
    client.callTool({ name: "agent_start", arguments: { adapter: "mock", cwd: "/tmp", ...args } })
  return { client, registry, startSession, start, caller }
}

let previousHome: string | undefined
let home: string

beforeEach(async () => {
  previousHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-agent-start-operator-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

describe("agent_start operator binding (AIP-46 rules 1, 2, 4)", () => {
  it("records operator and operatorDigest on the session descriptor", async () => {
    const { registry, start } = await setup()
    const body = parseToolJson(await start({ operator: "operator:cto@acme/main", operatorDigest: "sha256:aaa" }))
    expect(registry.get(body.id)).toMatchObject({
      operator: "operator:cto@acme/main",
      operatorDigest: "sha256:aaa",
    })
  })

  it("rewrites ws://operators/<slug> to the compact form without adding a workspace suffix", async () => {
    const { registry, start } = await setup()
    const body = parseToolJson(await start({ operator: "ws://operators/cto" }))
    expect(registry.get(body.id)?.operator).toBe("operator:cto")
  })

  it("starts no operator when the host names none", async () => {
    const { registry, start } = await setup()
    const body = parseToolJson(await start({}))
    expect(registry.get(body.id)?.operator).toBeUndefined()
    expect(registry.get(body.id)?.operatorDigest).toBeUndefined()
  })

  it.each(["cto", "operator:", "operator:Bad Slug", "operator:cto@nowhere", "ws://operators/cto@acme/main", "user:cto"])(
    "refuses the malformed ref %j with operator_unresolvable before any session starts",
    async ref => {
      const { registry, startSession, start } = await setup()
      const res = (await start({ operator: ref })) as { isError?: boolean }
      expect(res.isError).toBe(true)
      expect(parseToolJson(res)).toMatchObject({ error: "operator_unresolvable" })
      expect(startSession).not.toHaveBeenCalled()
      expect(registry.list()).toHaveLength(0)
    },
  )

  it("refuses an operatorDigest that names no operator", async () => {
    const { startSession, start } = await setup()
    const res = (await start({ operatorDigest: "sha256:aaa" })) as { isError?: boolean }
    expect(res.isError).toBe(true)
    expect(parseToolJson(res)).toMatchObject({ error: "operator_unresolvable" })
    expect(startSession).not.toHaveBeenCalled()
  })

  describe("a session caller (rule 4)", () => {
    it("may name the operator of its own session", async () => {
      const { registry, start } = await setup({ caller: { operator: "operator:cto" } })
      const body = parseToolJson(await start({ operator: "ws://operators/cto" }))
      expect(registry.get(body.id)?.operator).toBe("operator:cto")
    })

    it("is refused when it names another operator", async () => {
      const { registry, startSession, start } = await setup({ caller: { operator: "operator:cto" } })
      const res = (await start({ operator: "operator:cfo" })) as { isError?: boolean }
      expect(res.isError).toBe(true)
      expect(parseToolJson(res)).toMatchObject({ error: "delegation_denied" })
      expect(startSession).not.toHaveBeenCalled()
      expect(registry.list()).toHaveLength(1)
    })

    it("is refused when its own session has no operator", async () => {
      const { start } = await setup({ caller: {} })
      const res = (await start({ operator: "operator:cto" })) as { isError?: boolean }
      expect(res.isError).toBe(true)
      expect(parseToolJson(res)).toMatchObject({ error: "delegation_denied" })
    })

    it("starts a nested spawn that names none without an operator, never inheriting the caller's", async () => {
      const { registry, start, caller } = await setup({
        caller: { operator: "operator:cto", operatorDigest: "sha256:aaa" },
      })
      const body = parseToolJson(await start({}))
      expect(body.id).not.toBe(caller!.id)
      expect(registry.get(caller!.id)).toMatchObject({ operator: "operator:cto", operatorDigest: "sha256:aaa" })
      expect(registry.get(body.id)?.operator).toBeUndefined()
      expect(registry.get(body.id)?.operatorDigest).toBeUndefined()
    })
  })
})

describe("agent_start agentId / agentPath (MCP twin of POST /sessions/agent)", () => {
  it("spawns the agent an agentPath names, recording its manifest identity", async () => {
    const dir = join(home, ".agents", "coach")
    await mkdir(dir, { recursive: true })
    const path = join(dir, "AGENT.md")
    await writeFile(
      path,
      ["---", "schema: agent/v1", "id: coach", "description: Agent coach", "model: test-model", "---", "", "You are a coach."].join("\n"),
      "utf8",
    )
    const { registry, start } = await setup()
    const body = parseToolJson(await start({ cwd: home, agentPath: path }))
    expect(body.id).toMatch(/^sess_/)
    const desc = registry.get(body.id)
    expect(desc?.meta?.agentManifestPath).toBe(path)
    expect(desc?.meta?.agentId).toBe("coach")
  })

  it("resolves an agentId against <cwd>/.agents/<id>/AGENT.md", async () => {
    const dir = join(home, ".agents", "coach")
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, "AGENT.md"),
      ["---", "schema: agent/v1", "id: coach", "description: Agent coach", "model: test-model", "---", "", "You are a coach."].join("\n"),
      "utf8",
    )
    const { registry, start } = await setup()
    const body = parseToolJson(await start({ cwd: home, agentId: "coach" }))
    expect(registry.get(body.id)?.meta?.agentId).toBe("coach")
  })
})
