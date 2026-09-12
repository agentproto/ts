/**
 * `agent_prompt` queues by default — the MCP tool must never lose a prompt
 * to the mid-turn busy rejection (the CLI `sessions prompt` and HTTP
 * `?queue=true` arms already queue; the MCP tool now matches).
 *
 * Regression: a host application's fan-in and an orchestrating supervisor
 * both send `agent_prompt` bursts at a session that is still mid-turn; the
 * old default rejected with `session "<id>" is mid-turn` and the message
 * was gone. Now the prompt lands in `SessionDescriptor.promptQueue` and
 * dispatches at turn end, in FIFO order. Explicit `queue: false` restores
 * the old rejection, with a message naming the alternatives.
 */

import { describe, it, expect, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerAgentTools } from "../agent-tools.js"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { routeInboundMessage } from "../inbound-router.js"
import type { InboundRouterDeps } from "../inbound-router.js"
import type { TransmitterBinding } from "../transmitter-bindings.js"

/** `runAgentTurn` auto-wraps a raw string prompt into a single ACP
 *  text content block before handing it to `agentSession.send()` — the
 *  fixtures below record that wrapped shape, not the raw string. */
function wrapped(text: string): string {
  return JSON.stringify({ type: "text", text })
}

/** A fake session whose first turn is mid-flight until `release()` is
 *  called, then completes normally; any later turn completes instantly.
 *  Records the order turns actually started in. */
function busyThenCompletesAgentSession(): {
  agent: AgentSessionLike
  events: string[]
  release: () => void
} {
  const events: string[] = []
  let releaseFirstTurn!: () => void
  const firstTurnGate = new Promise<void>(resolve => {
    releaseFirstTurn = resolve
  })
  let turnCount = 0
  const agent: AgentSessionLike = {
    sessionId: "busy-then-completes-session",
    async *send(message: unknown) {
      turnCount++
      if (turnCount === 1) {
        events.push(`turn1-started:${JSON.stringify(message)}`)
        await firstTurnGate
        events.push("turn1-ended")
        yield { kind: "turn-end", reason: "completed" }
        return
      }
      events.push(`turn${turnCount}-started:${JSON.stringify(message)}`)
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
  return { agent, events, release: releaseFirstTurn }
}

async function makeMcpClient(registry: ReturnType<typeof createSessionsRegistry>) {
  const server = new McpServer({ name: "agent-prompt-queue-server", version: "0.0.0" })
  registerAgentTools(server, { registry })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "agent-prompt-queue-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

describe("agent_prompt (MCP): queue by default", () => {
  it("queues a prompt on a mid-turn session (no flag needed) and dispatches it at turn end", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { agent, events, release } = busyThenCompletesAgentSession()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })
    const client = await makeMcpClient(registry)

    const first = (await client.callTool({
      name: "agent_prompt",
      arguments: { sessionId: desc.id, prompt: "first" },
    })) as { isError?: boolean; content?: { type: string; text: string }[] }
    expect(first.isError).toBeUndefined()
    expect(JSON.parse(String(first.content?.[0]?.text)).queued).toBe(true)
    expect(registry.get(desc.id)?.busy).toBe(true)

    // No `queue` flag passed — the default is queue-on-busy now.
    const second = (await client.callTool({
      name: "agent_prompt",
      arguments: { sessionId: desc.id, prompt: "second" },
    })) as { isError?: boolean; content?: { type: string; text: string }[] }
    expect(second.isError).toBeUndefined()
    expect(JSON.parse(String(second.content?.[0]?.text)).queued).toBe(true)

    // The prompt is durably parked in the session's FIFO queue...
    expect(registry.get(desc.id)?.promptQueue).toHaveLength(1)
    // ...and the first turn was never disturbed.
    expect(events).toEqual([`turn1-started:${wrapped("first")}`])

    // Turn end dispatches the queued prompt as the next turn.
    release()
    await vi.waitFor(() => {
      expect(registry.get(desc.id)?.busy).toBe(false)
      expect(registry.get(desc.id)?.promptQueue).toHaveLength(0)
    })
    expect(events).toEqual([
      `turn1-started:${wrapped("first")}`,
      "turn1-ended",
      `turn2-started:${wrapped("second")}`,
    ])

    client.close()
    registry.shutdown()
  })

  it("delivers two back-to-back prompts in FIFO order, one turn each", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { agent, events, release } = busyThenCompletesAgentSession()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })
    const client = await makeMcpClient(registry)

    void (await client.callTool({
      name: "agent_prompt",
      arguments: { sessionId: desc.id, prompt: "first" },
    }))
    void (await client.callTool({
      name: "agent_prompt",
      arguments: { sessionId: desc.id, prompt: "second" },
    }))
    void (await client.callTool({
      name: "agent_prompt",
      arguments: { sessionId: desc.id, prompt: "third" },
    }))

    // QueuedPrompt.message is the raw prompt (wrapping happens at dispatch).
    expect(registry.get(desc.id)?.promptQueue?.map(p => p.message)).toEqual([
      "second",
      "third",
    ])

    release()
    await vi.waitFor(() => {
      expect(registry.get(desc.id)?.promptQueue).toHaveLength(0)
    })
    // Both dispatched, strictly in queue order, each as its own turn.
    expect(events).toEqual([
      `turn1-started:${wrapped("first")}`,
      "turn1-ended",
      `turn2-started:${wrapped("second")}`,
      `turn3-started:${wrapped("third")}`,
    ])

    client.close()
    registry.shutdown()
  })

  it("explicit queue: false on a mid-turn session rejects, naming the alternatives verbatim", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { agent, events } = busyThenCompletesAgentSession()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })
    const client = await makeMcpClient(registry)

    void (await client.callTool({
      name: "agent_prompt",
      arguments: { sessionId: desc.id, prompt: "first" },
    }))
    expect(registry.get(desc.id)?.busy).toBe(true)

    const rejected = (await client.callTool({
      name: "agent_prompt",
      arguments: { sessionId: desc.id, prompt: "second", queue: false },
    })) as { isError?: boolean; content?: { text: string }[] }
    expect(rejected.isError).toBe(true)
    expect(String(rejected.content?.[0]?.text)).toContain(
      "pass queue: true, or use `agentproto sessions prompt`"
    )
    // Nothing queued, nothing dispatched.
    expect(registry.get(desc.id)?.promptQueue).toBeUndefined()
    expect(events).toEqual([`turn1-started:${wrapped("first")}`])

    client.close()
    registry.shutdown()
  })

  it("an idle session with the default queue flag dispatches immediately — queue is a no-op when idle", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { agent, events, release } = busyThenCompletesAgentSession()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })
    const client = await makeMcpClient(registry)

    const res = (await client.callTool({
      name: "agent_prompt",
      arguments: { sessionId: desc.id, prompt: "hello" },
    })) as { isError?: boolean }
    expect(res.isError).toBeUndefined()
    // This fake's first turn still waits on the gate — release it so the
    // turn can actually finish (proving queue didn't park it anywhere).
    release()
    await vi.waitFor(() => {
      expect(registry.get(desc.id)?.busy).toBe(false)
    })
    expect(registry.get(desc.id)?.promptQueue).toBeUndefined()
    expect(events).toEqual([
      `turn1-started:${wrapped("hello")}`,
      "turn1-ended",
    ])

    client.close()
    registry.shutdown()
  })
})

describe("inbound router: queue on mid-turn, never reject", () => {
  function makeDeps(
    overrides?: Partial<InboundRouterDeps>,
  ): InboundRouterDeps & { enqueuePrompt: ReturnType<typeof vi.fn> } {
    const enqueuePrompt = vi.fn(async () => {})
    const binding: TransmitterBinding = {
      alias: "agentpush",
      source: "+33600000000",
      contactRef: "alice",
      sessionId: "sess_1",
      mode: "route",
      lastSeenTs: 0,
    }
    return {
      bindings: {
        get: () => binding,
        upsert: () => undefined,
        remove: () => undefined,
        list: () => [binding],
      },
      enqueuePrompt,
      isSessionAlive: () => true,
      restartSession: vi.fn(async (id: string) => id),
      ...overrides,
    } as never
  }

  const msg = {
    alias: "agentpush",
    source: "+33600000000",
    contactRef: "alice",
    text: "hello from alice",
  }

  it("passes queue: true so a mid-turn session queues the inbound message instead of rejecting it", async () => {
    const deps = makeDeps()
    await routeInboundMessage(deps, msg, "route")
    expect(deps.enqueuePrompt).toHaveBeenCalledWith("sess_1", "hello from alice", {
      queue: true,
    })
  })

  it("a mid-turn bound session ends up with the inbound message in its promptQueue, not an error", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { agent, events, release } = busyThenCompletesAgentSession()
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })
    void (await registry.enqueuePrompt(desc.id, "first"))
    await vi.waitFor(() => expect(registry.get(desc.id)?.busy).toBe(true))

    const binding: TransmitterBinding = {
      alias: "agentpush",
      source: "+33600000000",
      contactRef: "alice",
      sessionId: desc.id,
      mode: "route",
      lastSeenTs: 0,
    }
    const deps: InboundRouterDeps = {
      bindings: {
        get: () => binding,
        upsert: () => binding,
        remove: () => false,
        list: () => [binding],
      },
      enqueuePrompt: (id, text, opts) =>
        registry.enqueuePrompt(id, text, { ...opts, source: "inbound:agentpush" }),
      isSessionAlive: () => registry.get(desc.id)?.status === "running",
      restartSession: async () => desc.id,
    }

    const result = await routeInboundMessage(deps, msg, "route")
    expect(result).toEqual({ action: "routed", sessionId: desc.id })
    // Queued durably — not rejected, not lost.
    expect(registry.get(desc.id)?.promptQueue).toHaveLength(1)
    expect(
      (registry.get(desc.id)?.promptQueue?.[0]?.message as string)
    ).toContain("hello from alice")

    release()
    await vi.waitFor(() => {
      expect(registry.get(desc.id)?.busy).toBe(false)
      expect(registry.get(desc.id)?.promptQueue).toHaveLength(0)
    })
    expect(events).toEqual([
      `turn1-started:${wrapped("first")}`,
      "turn1-ended",
      `turn2-started:${wrapped("hello from alice")}`,
    ])

    registry.shutdown()
  })
})