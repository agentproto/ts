/**
 * Unit tests for the `session_restart` MCP tool (session-tools.ts).
 *
 * Mirrors what `agentproto sessions restart <id>` does on the CLI, but
 * in-process: look up a (possibly historical) descriptor, pick a resume
 * strategy via the shared `decideRestartStrategy` (resume-strategies.ts),
 * and respawn. Covers the four branches of that decision tree end-to-end
 * through the MCP tool surface:
 *   - pty-native  (claude-code with a captured resume id)
 *   - agent/ACP   (adapter with no native strategy, resume via adapterSessionId)
 *   - restarting a still-alive vs. already-dead session (no liveness gate)
 *   - unsupported (generic `command` session)
 */

import { describe, it, expect } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type {
  AgentSessionLike,
  AgentStreamEvent,
  PtyFactory,
  PtyProcess,
  SessionsRegistry,
} from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

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

/** Records every `startSession` call so tests can assert on
 *  resumeSessionId / cwd / model without spying on internals. */
function makeResolver(opts: {
  /** When set, the FIRST call with a `resumeSessionId` throws this
   *  message (simulates the adapter rejecting an unknown/never-
   *  persisted resume id) — the tool should retry without it. */
  rejectResumeOnce?: boolean
} = {}): {
  resolver: AgentAdapterResolver
  calls: Array<{ adapter: string; cwd: string; resumeSessionId?: string }>
} {
  const calls: Array<{ adapter: string; cwd: string; resumeSessionId?: string }> = []
  let rejected = false
  const resolver: AgentAdapterResolver = async slug => ({
    async startSession(sessOpts) {
      calls.push({
        adapter: slug,
        cwd: sessOpts.cwd,
        ...(sessOpts.resumeSessionId ? { resumeSessionId: sessOpts.resumeSessionId } : {}),
      })
      if (opts.rejectResumeOnce && sessOpts.resumeSessionId && !rejected) {
        rejected = true
        throw new Error("Resource not found")
      }
      return fakeAgentSession(slug)
    },
    commandPreview: `mock-${slug}`,
  })
  return { resolver, calls }
}

function makeFakePtyFactory(): PtyFactory {
  return (): PtyProcess => ({
    pid: 4242,
    write: () => {},
    resize: () => {},
    kill: () => {},
    onData: () => {},
    onExit: () => {},
  })
}

async function buildHarness(
  resolverOpts: Parameters<typeof makeResolver>[0] = {},
): Promise<{
  client: Client
  registry: SessionsRegistry
  calls: Array<{ adapter: string; cwd: string; resumeSessionId?: string }>
  close: () => Promise<void>
}> {
  const sessionEvents = createSessionEventBus()
  const { resolver, calls } = makeResolver(resolverOpts)
  const registry = createSessionsRegistry({
    sessionEvents,
    persist: false,
    spawnPty: makeFakePtyFactory(),
  })
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })

  registerSessionTools(server, {
    registry,
    resolveAgentAdapter: resolver,
    ptyEnabled: true,
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)

  return { client, registry, calls, close: () => client.close() }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolJson(result: any): Record<string, unknown> {
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}"
  return JSON.parse(text)
}

describe("session_restart", () => {
  it("pty-native: respawns via the provider's native resume command when a resume id was captured", async () => {
    const { client, registry, close } = await buildHarness()

    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("claude"),
      adapterSlug: "claude-code",
    })
    // Simulate the output sniffer having captured `claude --resume <id>`
    // from the prior session's exit line.
    prev.resumeMetadata = { claudeResumeId: "0e483f81-1a44-4bec-9667-b37158450296" }
    registry.kill(prev.id)

    const result = await client.callTool({
      name: "session_restart",
      arguments: { idOrName: prev.id },
    })
    expect(result.isError).toBeFalsy()
    const desc = toolJson(result)

    expect(desc.id).not.toBe(prev.id)
    expect(desc.resumedFrom).toBe(prev.id)
    expect(desc.resumeVia).toBe("resumed via claude --resume")
    expect(desc.kind).toBe("terminal")
    expect(desc.pty).toBe(true)
    expect(desc.argv).toEqual([
      "claude",
      "--resume",
      "0e483f81-1a44-4bec-9667-b37158450296",
    ])

    await close()
    registry.shutdown()
  })

  it("agent/ACP: resumes via the adapter's own session id for an adapter with no native strategy", async () => {
    const { client, registry, calls, close } = await buildHarness()

    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("hermes"),
      adapterSlug: "hermes",
    })
    registry.kill(prev.id)

    const result = await client.callTool({
      name: "session_restart",
      arguments: { idOrName: prev.id },
    })
    expect(result.isError).toBeFalsy()
    const desc = toolJson(result)

    expect(desc.id).not.toBe(prev.id)
    expect(desc.resumedFrom).toBe(prev.id)
    expect(desc.resumeVia).toBe("resumed via ACP")
    expect(desc.kind).toBe("agent-cli")
    expect(desc.adapterSlug).toBe("hermes")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.resumeSessionId).toBe(prev.adapterSessionId)

    await close()
    registry.shutdown()
  })

  it("agent/ACP: retries as a fresh spawn when the adapter rejects the resume id as not found", async () => {
    const { client, registry, calls, close } = await buildHarness({ rejectResumeOnce: true })

    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("hermes"),
      adapterSlug: "hermes",
    })
    registry.kill(prev.id)

    const result = await client.callTool({
      name: "session_restart",
      arguments: { idOrName: prev.id },
    })
    expect(result.isError).toBeFalsy()
    const desc = toolJson(result)

    expect(desc.resumeFallback).toBe(true)
    expect(desc.resumeVia).toBe("")

    // First call attempted the resume id and was rejected; second call
    // (the actual spawn that succeeded) carried no resumeSessionId.
    expect(calls).toHaveLength(2)
    expect(calls[0]?.resumeSessionId).toBe(prev.adapterSessionId)
    expect(calls[1]?.resumeSessionId).toBeUndefined()

    await close()
    registry.shutdown()
  })

  it("restarts a still-alive session the same way as a dead one (no liveness gate)", async () => {
    const { client, registry, close } = await buildHarness()

    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("hermes"),
      adapterSlug: "hermes",
    })
    expect(registry.get(prev.id)?.status).toBe("running")

    const result = await client.callTool({
      name: "session_restart",
      arguments: { idOrName: prev.id },
    })
    expect(result.isError).toBeFalsy()
    const desc = toolJson(result)

    expect(desc.id).not.toBe(prev.id)
    expect(desc.resumedFrom).toBe(prev.id)
    // Restarting doesn't touch the prior session — it's left exactly as
    // it was (still "running"), same as the CLI's `sessions restart`.
    expect(registry.get(prev.id)?.status).toBe("running")

    await close()
    registry.shutdown()
  })

  it("restarts an already-dead (killed) session, producing a fresh id", async () => {
    const { client, registry, close } = await buildHarness()

    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: fakeAgentSession("hermes"),
      adapterSlug: "hermes",
    })
    registry.kill(prev.id)
    expect(registry.get(prev.id)?.status).toBe("killed")

    const result = await client.callTool({
      name: "session_restart",
      arguments: { idOrName: prev.id },
    })
    expect(result.isError).toBeFalsy()
    const desc = toolJson(result)

    expect(desc.id).not.toBe(prev.id)
    expect(desc.status).toBe("running")
    // The dead descriptor stays in history, untouched.
    expect(registry.get(prev.id)?.status).toBe("killed")

    await close()
    registry.shutdown()
  })

  it("returns an error for a generic command session — restart is unsupported", async () => {
    const { client, registry, close } = await buildHarness()

    const prev = registry.spawn({
      kind: "command",
      workspaceSlug: "default",
      cwd: process.cwd(),
      argv: ["true"],
    })

    const result = await client.callTool({
      name: "session_restart",
      arguments: { idOrName: prev.id },
    })
    expect(result.isError).toBe(true)
    const body = toolJson(result)
    expect(String(body.error)).toMatch(/generic command session/)

    await close()
    registry.shutdown()
  })

  it("returns an error when the session id/name is unknown", async () => {
    const { client, close } = await buildHarness()

    const result = await client.callTool({
      name: "session_restart",
      arguments: { idOrName: "sess_does_not_exist" },
    })
    expect(result.isError).toBe(true)
    const body = toolJson(result)
    expect(String(body.error)).toMatch(/no session/)

    await close()
  })
})
