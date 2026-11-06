/**
 * Claude Desktop MCP entries share ONE unverified caller identity
 * (`claude-desktop`) that has no hook inbox and no socket wake. Such a caller
 * declares its own `cc:<session_id>`:
 *  - `agent_start.parent` (the child's `message_parent` reaches the cc: row);
 *  - `message_send.replyTo` (a `message_reply` is routed to the cc: row).
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

describe("message_reply to the shared claude-desktop identity", () => {
  it("routes to the cc: id declared as replyTo", async () => {
    const registry = setup()
    const target = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeSession(),
      adapterSlug: "mock",
    })
    const desk = await connect(registry, "claude-desktop", false)
    const spy = vi.spyOn(registry, "sendMessage")
    const sent = await desk.call("message_send", { to: target.id, text: "ping", replyTo: "cc:abc" })
    expect(sent.isError).toBeFalsy()
    const original = spy.mock.calls.map(c => c[0] as any).find(m => m.to === target.id)!
    expect(original.replyAddress).toBe("cc:abc")
    expect(original.from).toMatchObject({ sessionId: "claude-desktop", unverified: true })
    vi.spyOn(registry, "findReceivedMessage").mockReturnValue(original)

    const asTarget = await connect(registry, target.id, false)
    const reply = await asTarget.call("message_reply", { replyTo: original.id, text: "pong" })
    expect(reply.isError, JSON.stringify(reply)).toBeFalsy()
    const replyTargets = spy.mock.calls.map(c => (c[0] as any).to).slice(1)
    expect(replyTargets).toEqual(["cc:abc"])
  })

  it("does not invent a cc: route when none was declared (stays on the sender row)", async () => {
    const registry = setup()
    const target = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeSession(),
      adapterSlug: "mock",
    })
    const desk = await connect(registry, "claude-desktop", false)
    const spy = vi.spyOn(registry, "sendMessage")
    await desk.call("message_send", { to: target.id, text: "ping" })
    const original = spy.mock.calls.map(c => c[0] as any).find(m => m.to === target.id)!
    vi.spyOn(registry, "findReceivedMessage").mockReturnValue(original)
    const asTarget = await connect(registry, target.id, false)
    await asTarget.call("message_reply", { replyTo: original.id, text: "pong" })
    // Whether the shared row is reachable is the reply ACL's call (#2607);
    // what matters here is that no cc: row is ever substituted.
    expect(spy.mock.calls.map(c => (c[0] as any).to).slice(1)).not.toContain("cc:abc")
  })

  it("rejects a malformed cc: replyTo", async () => {
    const registry = setup()
    const desk = await connect(registry, "claude-desktop", false)
    const res = await desk.call("message_send", { to: "parent", text: "x", replyTo: "cc:bad id!" })
    expect(res.isError).toBe(true)
  })
})
