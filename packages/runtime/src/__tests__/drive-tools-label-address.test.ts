/**
 * `agent_prompt` / `agent_interrupt` / `agent_kill` address by label:
 * `sessionId` (or `id`) of the form `label:<operatorLabel>` resolves to the
 * single LIVE session carrying that immutable operator label. Zero live
 * matches is `no_live_session_for_label`, several is `ambiguous_label`. The
 * owner gate runs on the RESOLVED session, so a label never widens who can
 * drive it.
 */

import { describe, it, expect } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerAgentTools } from "../agent-tools.js"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"

function idleSession(): AgentSessionLike {
  return {
    sessionId: "idle-session",
    async *send() {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

async function connect(registry: ReturnType<typeof createSessionsRegistry>, callerSessionId?: string) {
  const server = new McpServer({ name: "label-drive", version: "0.0.0" })
  registerAgentTools(server, { registry, ...(callerSessionId ? { callerSessionId } : {}) })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "label-drive-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean
      content: Array<{ text: string }>
    }
    const text = r.content[0]!.text
    let body: Record<string, any> | undefined
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
    return { isError: r.isError === true, text, body }
  }
}

function spawn(registry: ReturnType<typeof createSessionsRegistry>, operatorLabel?: string, parentSessionId?: string) {
  const d = registry.spawnAgent({
    workspaceSlug: "default",
    cwd: "/tmp",
    agentSession: idleSession(),
    adapterSlug: "fake",
    ...(parentSessionId ? { parentSessionId } : {}),
  })
  if (operatorLabel) registry.setOperatorLabel(d.id, operatorLabel)
  return d
}

describe("drive tools addressed by label", () => {
  it("agent_prompt, agent_interrupt and agent_kill resolve label:<operatorLabel> to the live session", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const brain = spawn(registry, "brain")
    const call = await connect(registry)

    const prompted = await call("agent_prompt", { sessionId: "label:brain", prompt: "go" })
    expect(prompted.isError).toBe(false)
    expect(prompted.text).toContain(brain.id)

    const viaId = await call("agent_prompt", { id: "label:brain", prompt: "again" })
    expect(viaId.isError).toBe(false)

    const interrupted = await call("agent_interrupt", { sessionId: "label:brain" })
    expect(interrupted.body).toMatchObject({ ok: true, sessionId: brain.id })

    const killed = await call("agent_kill", { sessionId: "label:brain" })
    expect(killed.body).toMatchObject({ ok: true, sessionId: brain.id })
    expect(registry.get(brain.id)?.status).toBe("killed")
    registry.shutdown()
  })

  it("a killed twin never matches: no_live_session_for_label, and the live one wins when both exist", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const old = spawn(registry, "brain")
    registry.kill(old.id)
    const call = await connect(registry)

    for (const [tool, args] of [
      ["agent_prompt", { prompt: "go" }],
      ["agent_interrupt", {}],
      ["agent_kill", {}],
    ] as const) {
      const r = await call(tool, { sessionId: "label:brain", ...args })
      expect(r.isError).toBe(true)
      expect(r.body).toMatchObject({ ok: false, error: "no_live_session_for_label" })
    }

    const fresh = spawn(registry, "brain")
    const r = await call("agent_prompt", { sessionId: "label:brain", prompt: "go" })
    expect(r.isError).toBe(false)
    expect(r.text).toContain(fresh.id)
    registry.shutdown()
  })

  it("two live sessions with the label is ambiguous_label and nothing is driven", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const a = spawn(registry, "brain")
    const b = spawn(registry, "brain")
    const call = await connect(registry)

    for (const [tool, args] of [
      ["agent_prompt", { prompt: "go" }],
      ["agent_interrupt", {}],
      ["agent_kill", {}],
    ] as const) {
      const r = await call(tool, { sessionId: "label:brain", ...args })
      expect(r.isError).toBe(true)
      expect(r.body?.error).toBe("ambiguous_label")
      expect(r.body?.message).toContain(a.id)
      expect(r.body?.message).toContain(b.id)
    }
    expect(registry.get(a.id)?.status).toBe("running")
    expect(registry.get(b.id)?.status).toBe("running")
    registry.shutdown()
  })

  it("the ambiguity error does not name sessions the caller may not drive", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const mine = spawn(registry)
    const owned = spawn(registry, "brain", mine.id)
    const foreign = spawn(registry, "brain")
    const call = await connect(registry, mine.id)

    const r = await call("agent_prompt", { sessionId: "label:brain", prompt: "go" })
    expect(r.body?.error).toBe("ambiguous_label")
    expect(r.body?.message).toContain(owned.id)
    expect(r.body?.message).not.toContain(foreign.id)
    expect(r.body?.message).toContain("1 more you may not drive")
    registry.shutdown()
  })

  it("the owner gate runs on the resolved session: a label does not grant access", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const owner = spawn(registry)
    const target = spawn(registry, "brain", owner.id)
    const stranger = spawn(registry)

    const asStranger = await connect(registry, stranger.id)
    for (const [tool, args] of [
      ["agent_prompt", { prompt: "go" }],
      ["agent_interrupt", {}],
      ["agent_kill", {}],
    ] as const) {
      const r = await asStranger(tool, { sessionId: "label:brain", ...args })
      expect(r.isError).toBe(true)
      expect(r.text).toContain(`${tool}: session "${target.id}" may only be driven by its owner`)
    }
    expect(registry.get(target.id)?.status).toBe("running")

    const asOwner = await connect(registry, owner.id)
    const ok = await asOwner("agent_prompt", { sessionId: "label:brain", prompt: "go" })
    expect(ok.isError).toBe(false)

    registry.setPromptPolicy(target.id, ["label:stranger-label"])
    registry.setOperatorLabel(stranger.id, "stranger-label")
    const granted = await asStranger("agent_prompt", { sessionId: "label:brain", prompt: "go" })
    expect(granted.isError).toBe(false)
    registry.shutdown()
  })

  it("an empty label is invalid and a plain session id is unchanged", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const s = spawn(registry, "brain")
    const call = await connect(registry)
    const empty = await call("agent_prompt", { sessionId: "label:", prompt: "go" })
    expect(empty.body).toMatchObject({ ok: false, error: "invalid_label" })
    const plain = await call("agent_prompt", { sessionId: s.id, prompt: "go" })
    expect(plain.isError).toBe(false)
    registry.shutdown()
  })
})
