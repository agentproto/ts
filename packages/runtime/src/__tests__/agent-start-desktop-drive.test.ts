/**
 * A Claude Desktop supervisor declares `parent: "cc:<id>"` at spawn, so the
 * child's recorded owner is that `cc:` row, which no Desktop MCP call can ever
 * present (calls arrive as the shared `claude-desktop` identity). Without a
 * default grant the supervisor could not drive its own children. When the spawn
 * leaves `allowPromptFrom` unspecified the daemon records `claude-desktop` in
 * it; an explicit list (including `[]`) is never touched, and no other caller
 * gets a new right.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerAgentTools } from "../agent-tools.js"
import { createSessionsRegistry, type AgentSessionLike, type SessionsRegistry } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

const fakeSession = (): AgentSessionLike => ({
  sessionId: "adapter_desktop_drive_test",
  // eslint-disable-next-line require-yield
  async *send() {},
  async cancel() {},
  async close() {},
})

const json = (result: unknown): any => {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  return JSON.parse(content!.find(c => c.type === "text")!.text!)
}

async function connect(
  registry: SessionsRegistry,
  opts: { callerSessionId?: string; noCallerIdentity?: "accept" } = {},
) {
  const resolveAgentAdapter: AgentAdapterResolver = async () => ({
    startSession: (async () => fakeSession()) as any,
    commandPreview: "mock-adapter",
  })
  const server = new McpServer({ name: "desktop-drive", version: "0.0.0" })
  registerAgentTools(server, {
    registry,
    resolveAgentAdapter,
    ...(opts.callerSessionId ? { callerSessionId: opts.callerSessionId } : {}),
    ...(opts.noCallerIdentity ? { noCallerIdentity: opts.noCallerIdentity } : {}),
  })
  const [c, s] = InMemoryTransport.createLinkedPair()
  await server.connect(s)
  const client = new Client({ name: "desktop-drive-client", version: "0.0.0" })
  await client.connect(c)
  return {
    call: (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; content?: Array<{ text?: string }> }>,
  }
}

let previousHome: string | undefined
let home: string
beforeEach(async () => {
  previousHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-desktop-drive-"))
  process.env.HOME = home
})
afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

const setup = () => {
  const registry = createSessionsRegistry({ persist: false })
  registry.touchExternal({ id: "claude-desktop", host: "claude-desktop" })
  registry.touchExternal({ id: "cc:abc", host: "claude-cli" })
  return registry
}

const spawnAs = async (
  registry: SessionsRegistry,
  caller: string,
  args: Record<string, unknown>,
) => {
  const c = await connect(registry, { callerSessionId: caller })
  const res = await c.call("agent_start", { adapter: "mock", cwd: "/tmp", ...args })
  expect(res.isError).toBeFalsy()
  return registry.get(json(res).id)!
}

describe("a Claude Desktop supervisor drives the children it declared", () => {
  it("records claude-desktop in allowPromptFrom and lets it prompt, interrupt and kill", async () => {
    const registry = setup()
    const child = await spawnAs(registry, "claude-desktop", { parent: "cc:abc" })
    expect(child.parentSessionId).toBe("cc:abc")
    expect(child.allowPromptFrom).toEqual(["claude-desktop"])

    const desk = await connect(registry, { callerSessionId: "claude-desktop" })
    const prompted = await desk.call("agent_prompt", { sessionId: child.id, prompt: "go" })
    expect(prompted.isError, prompted.content?.[0]?.text).toBeFalsy()
    const interrupted = await desk.call("agent_interrupt", { sessionId: child.id })
    expect(interrupted.isError, interrupted.content?.[0]?.text).toBeFalsy()
    const killed = await desk.call("agent_kill", { sessionId: child.id })
    expect(killed.isError, killed.content?.[0]?.text).toBeFalsy()
  })

  it("an explicit allowPromptFrom wins and is not extended", async () => {
    const registry = setup()
    const child = await spawnAs(registry, "claude-desktop", {
      parent: "cc:abc",
      allowPromptFrom: ["sess_friend"],
    })
    expect(child.allowPromptFrom).toEqual(["sess_friend"])
    const desk = await connect(registry, { callerSessionId: "claude-desktop" })
    expect((await desk.call("agent_kill", { sessionId: child.id })).isError).toBe(true)
  })

  it("allowPromptFrom: [] opts out of the default", async () => {
    const registry = setup()
    const child = await spawnAs(registry, "claude-desktop", { parent: "cc:abc", allowPromptFrom: [] })
    expect(child.allowPromptFrom).toBeUndefined()
    const desk = await connect(registry, { callerSessionId: "claude-desktop" })
    expect((await desk.call("agent_kill", { sessionId: child.id })).isError).toBe(true)
  })

  it("grants no right to the policy editor: claude-desktop cannot widen the list", async () => {
    const registry = setup()
    const child = await spawnAs(registry, "claude-desktop", { parent: "cc:abc" })
    const desk = await connect(registry, { callerSessionId: "claude-desktop" })
    const res = await desk.call("agent_set_prompt_policy", { sessionId: child.id, allowPromptFrom: ["any"] })
    expect(res.isError).toBe(true)
    expect(registry.get(child.id)!.allowPromptFrom).toEqual(["claude-desktop"])
  })
})

describe("nobody else gains a right", () => {
  it("a desktop spawn with no declared parent stays as it was (no grant)", async () => {
    const registry = setup()
    const child = await spawnAs(registry, "claude-desktop", {})
    expect(child.parentSessionId).toBe("claude-desktop")
    expect(child.allowPromptFrom).toBeUndefined()
  })

  it("a verified session-parent spawn records no allowPromptFrom", async () => {
    const registry = setup()
    const me = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeSession(),
      adapterSlug: "mock",
    })
    const child = await spawnAs(registry, me.id, {})
    expect(child.parentSessionId).toBe(me.id)
    expect(child.allowPromptFrom).toBeUndefined()
    const desk = await connect(registry, { callerSessionId: "claude-desktop" })
    expect((await desk.call("agent_kill", { sessionId: child.id })).isError).toBe(true)
  })

  it("an identity-less declared-parent spawn records no allowPromptFrom", async () => {
    const registry = setup()
    const anon = await connect(registry, { noCallerIdentity: "accept" })
    const res = await anon.call("agent_start", { adapter: "mock", cwd: "/tmp", parent: "cc:abc" })
    expect(res.isError).toBeFalsy()
    expect(registry.get(json(res).id)!.allowPromptFrom).toBeUndefined()
  })

  it("an attested cc: caller spawning under itself records no allowPromptFrom", async () => {
    const registry = setup()
    const child = await spawnAs(registry, "cc:abc", {})
    expect(child.parentSessionId).toBe("cc:abc")
    expect(child.allowPromptFrom).toBeUndefined()
  })

  it("other sessions still cannot drive a desktop-declared child", async () => {
    const registry = setup()
    const child = await spawnAs(registry, "claude-desktop", { parent: "cc:abc" })
    for (const caller of ["sess_stranger", "cc:other"]) {
      const c = await connect(registry, { callerSessionId: caller })
      expect((await c.call("agent_kill", { sessionId: child.id })).isError, caller).toBe(true)
      expect((await c.call("agent_prompt", { sessionId: child.id, prompt: "x" })).isError, caller).toBe(true)
    }
  })
})
