/**
 * `agent_start.parent` and the identity-less spawn under
 * `mcp.noCallerIdentity`.
 *
 * Claude Code connects to a static MCP URL, so a tool call carries no caller
 * identity (the identity is per connection: `?callerSessionId=` or the
 * `x-agentproto-caller-session-id` header). Without it a spawned child is a
 * root with no parent and `message_parent` has nowhere to go. The caller can
 * DECLARE its `cc:<id>` address as `parent` (declared, not proven, the same
 * trust as a `replyTo` address); under `accept` the spawn is also tagged
 * anonymous and elevates nothing.
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
  sessionId: "adapter_declared_parent_test",
  // eslint-disable-next-line require-yield
  async *send() {},
  async cancel() {},
  async close() {},
})

function parseToolJson(result: unknown): any {
  if ((result as { isError?: boolean }).isError) throw new Error(JSON.stringify(result))
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}

async function connect(
  registry: SessionsRegistry,
  opts: { callerSessionId?: string; noCallerIdentity?: "block" | "ask" | "accept"; spawn?: boolean },
) {
  const startSession = vi.fn(async () => fakeSession())
  const resolveAgentAdapter: AgentAdapterResolver = async () => ({
    startSession: startSession as any,
    commandPreview: "mock-adapter",
  })
  const server = new McpServer({ name: "declared-parent-server", version: "0.0.0" })
  registerAgentTools(server, {
    registry,
    ...(opts.spawn === false ? {} : { resolveAgentAdapter }),
    ...(opts.callerSessionId ? { callerSessionId: opts.callerSessionId } : {}),
    ...(opts.noCallerIdentity ? { noCallerIdentity: opts.noCallerIdentity } : {}),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "declared-parent-client", version: "0.0.0" })
  await client.connect(clientTransport)
  const start = (args: Record<string, unknown>) =>
    client.callTool({ name: "agent_start", arguments: { adapter: "mock", cwd: "/tmp", ...args } })
  return { client, start, startSession }
}

let previousHome: string | undefined
let home: string

beforeEach(async () => {
  previousHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-agent-start-declared-parent-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

describe("agent_start.parent (declared cc:<id>)", () => {
  it("nests the child under the declared cc row so message_parent reaches it", async () => {
    const registry = createSessionsRegistry({ persist: false })
    registry.touchExternal({ id: "cc:abc123", host: "claude-cli" })
    const anon = await connect(registry, { noCallerIdentity: "accept" })
    const body = parseToolJson(await anon.start({ parent: "cc:abc123" }))
    const child = registry.get(body.id)!
    expect(child.parentSessionId).toBe("cc:abc123")
    expect(child.depth).toBe(1)

    // The child's own connection (self-ref callerSessionId) reports up.
    const sendMessage = vi.spyOn(registry, "sendMessage")
    const asChild = await connect(registry, { callerSessionId: child.id, spawn: false })
    const res = (await asChild.client.callTool({
      name: "message_parent",
      arguments: { message: "done" },
    })) as { isError?: boolean }
    expect(res.isError).toBeFalsy()
    expect(sendMessage).toHaveBeenCalled()
    expect(sendMessage.mock.calls.at(-1)![0]).toMatchObject({ to: "cc:abc123" })
  })

  it("the long-standing parentSessionId hint takes a cc: row too (works with a client holding a stale tool schema)", async () => {
    const registry = createSessionsRegistry({ persist: false })
    registry.touchExternal({ id: "cc:abc123", host: "claude-cli" })
    const anon = await connect(registry, { noCallerIdentity: "accept" })
    const body = parseToolJson(await anon.start({ parentSessionId: "cc:abc123", label: "e2e-t7-child-3", role: "supervisor" }))
    const child = registry.get(body.id)!
    expect(child.parentSessionId).toBe("cc:abc123")
    expect(child.depth).toBe(1)
  })

  it("without a declared parent an identity-less spawn is a root", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const anon = await connect(registry, { noCallerIdentity: "accept" })
    const body = parseToolJson(await anon.start({}))
    const child = registry.get(body.id)!
    expect(child.parentSessionId).toBeUndefined()
    expect(child.depth).toBe(0)
  })

  it("rejects a malformed parent before any session starts", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const anon = await connect(registry, { noCallerIdentity: "accept" })
    const res = (await anon.start({ parent: "not an id!!" })) as { isError?: boolean }
    expect(res.isError).toBe(true)
    expect(anon.startSession).not.toHaveBeenCalled()
    expect(registry.list()).toHaveLength(0)
  })

  it("refuses a declared parent when the call already carries an identity", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const me = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeSession(),
      adapterSlug: "mock",
    })
    const known = await connect(registry, { callerSessionId: me.id })
    const res = (await known.start({ parent: "cc:abc123" })) as { isError?: boolean }
    expect(res.isError).toBe(true)
    expect(known.startSession).not.toHaveBeenCalled()
  })
})

describe("agent_start without a caller identity", () => {
  it("accept tags the root anonymous", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const anon = await connect(registry, { noCallerIdentity: "accept" })
    const body = parseToolJson(await anon.start({}))
    expect(registry.get(body.id)?.meta?.anonymous).toBe("claude-code")
  })

  it("the default policy does not tag, and an identified caller is never tagged", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const plain = await connect(registry, {})
    expect(registry.get(parseToolJson(await plain.start({})).id)?.meta?.anonymous).toBeUndefined()
    const me = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeSession(),
      adapterSlug: "mock",
    })
    const known = await connect(registry, { callerSessionId: me.id, noCallerIdentity: "accept" })
    const body = parseToolJson(await known.start({}))
    expect(registry.get(body.id)?.meta?.anonymous).toBeUndefined()
    expect(registry.get(body.id)?.parentSessionId).toBe(me.id)
  })
})
