/**
 * Claude Desktop MCP entries share ONE unverified caller identity
 * (`claude-desktop`) that has no hook inbox and no socket wake. Such a caller
 * declares its own `cc:<session_id>` as `agent_start.parent` (the child's `message_parent` reaches the cc: row);
 * Declared, not proven. A verified identity may still not declare a parent.
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
  sessionId: "adapter_desktop_declared_test",
  // eslint-disable-next-line require-yield
  async *send() {},
  async cancel() {},
  async close() {},
})

const json = (result: unknown): any => {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  return JSON.parse(content!.find(c => c.type === "text")!.text!)
}

async function connect(registry: SessionsRegistry, callerSessionId: string, spawn = true) {
  const startSession = vi.fn(async () => fakeSession())
  const resolveAgentAdapter: AgentAdapterResolver = async () => ({
    startSession: startSession as any,
    commandPreview: "mock-adapter",
  })
  const server = new McpServer({ name: "desktop-declared", version: "0.0.0" })
  registerAgentTools(server, { registry, ...(spawn ? { resolveAgentAdapter } : {}), callerSessionId })
  const [c, s] = InMemoryTransport.createLinkedPair()
  await server.connect(s)
  const client = new Client({ name: "desktop-declared-client", version: "0.0.0" })
  await client.connect(c)
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean }>
  return { call, startSession }
}

let previousHome: string | undefined
let home: string
beforeEach(async () => {
  previousHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-desktop-declared-"))
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

describe("agent_start.parent from the shared claude-desktop identity", () => {
  it("accepts a declared cc: parent and reports to that row, not the shared one", async () => {
    const registry = setup()
    const desk = await connect(registry, "claude-desktop")
    const res = await desk.call("agent_start", { adapter: "mock", cwd: "/tmp", parent: "cc:abc" })
    expect(res.isError).toBeFalsy()
    const child = registry.get(json(res).id)!
    expect(child.parentSessionId).toBe("cc:abc")

    const spy = vi.spyOn(registry, "sendMessage")
    const asChild = await connect(registry, child.id, false)
    const sent = await asChild.call("message_parent", { message: "done" })
    expect(sent.isError).toBeFalsy()
    const targets = spy.mock.calls.map(c => (c[0] as { to: string }).to)
    expect(targets).toContain("cc:abc")
    expect(targets).not.toContain("claude-desktop")
  })

  it("message_parent carries the wake outcome and its hint back to the child", async () => {
    const registry = setup()
    const desk = await connect(registry, "claude-desktop")
    const res = await desk.call("agent_start", { adapter: "mock", cwd: "/tmp", parent: "cc:abc" })
    const child = registry.get(json(res).id)!
    const wake = {
      written: true,
      reason: "held-by-receiver-bypass",
      sessionId: "cc:abc",
      hint: "set crossSessionInbound to accept in ~/.claude/settings.json (agentproto doctor --fix)",
    }
    vi.spyOn(registry, "sendMessage").mockResolvedValue({
      messageId: "msg_x",
      delivered: { via: "inbox" },
      queued: false,
      urgencyApplied: "next-turn",
      wake: wake as any,
    })
    const asChild = await connect(registry, child.id, false)
    const sent = await asChild.call("message_parent", { message: "done" })
    expect(json(sent).wake).toEqual(wake)
  })

  it("without a declared parent the child still attaches under the shared row", async () => {
    const registry = setup()
    const desk = await connect(registry, "claude-desktop")
    const child = registry.get(json(await desk.call("agent_start", { adapter: "mock", cwd: "/tmp" })).id)!
    expect(child.parentSessionId).toBe("claude-desktop")
  })

  it("refuses a parent that is not a well-formed cc: address", async () => {
    const registry = setup()
    const desk = await connect(registry, "claude-desktop")
    for (const parent of ["cc:bad id!", "cc:", "sess_other"]) {
      const res = await desk.call("agent_start", { adapter: "mock", cwd: "/tmp", parent })
      expect(res.isError, parent).toBe(true)
    }
    expect(desk.startSession).not.toHaveBeenCalled()
  })

  it("still refuses a declared parent from a verified identity", async () => {
    const registry = setup()
    const me = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeSession(),
      adapterSlug: "mock",
    })
    const known = await connect(registry, me.id)
    const res = await known.call("agent_start", { adapter: "mock", cwd: "/tmp", parent: "cc:abc" })
    expect(res.isError).toBe(true)
    expect(known.startSession).not.toHaveBeenCalled()
  })
})
