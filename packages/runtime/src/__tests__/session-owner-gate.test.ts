/**
 * Session-owner gate — drives tools only accept the session's owner.
 *
 * The owner of a session is the caller that spawned it (its
 * `parentSessionId`, or the human operator for a root spawn). The MCP drive
 * tools (`agent_prompt` / `agent_interrupt` / `agent_kill` /
 * `session_restart` / `session_continue_fresh`) refuse calls coming from
 * ANOTHER agent session, unless the target's `allowPromptFrom` list names
 * the caller (or the wildcard `"any"`). The operator — no caller session —
 * always passes, and recorded prompts land caller-attributed
 * (`session:prompt` events: the callerSessionId, or `"operator"`).
 */

import { describe, it, expect, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerAgentTools } from "../agent-tools.js"
import { checkSessionOwnerGate, checkPromptPolicyEditor } from "../session-owner.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
} from "../sessions.js"
import type { SessionEvent, SessionEventBus } from "../session-event-bus.js"

function instantAgentSession(): AgentSessionLike {
  return {
    sessionId: "instant-session",
    async *send() {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; content?: Array<{ type: string; text?: string }> }> {
  return (await client.callTool({ name, arguments: args })) as never
}

async function connectClient(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "owner-gate-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

/** Two sessions: `parent` (a root operator spawn) and `child`, spawned by it. */
async function twoSessions(opts?: { allowPromptFrom?: string[] }) {
  const registry = createSessionsRegistry({ persist: false })
  const parent = registry.spawnAgent({
    workspaceSlug: "default",
    cwd: "/tmp",
    agentSession: instantAgentSession(),
    adapterSlug: "fake",
  })
  const child = {
    ...registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
      parentSessionId: parent.id,
    }),
  }
  if (opts?.allowPromptFrom?.length) {
    registry.setPromptPolicy(child.id, opts.allowPromptFrom)
  }
  return { registry, parent, child }
}

describe("checkSessionOwnerGate (pure)", () => {
  const target = { id: "sess_child", parentSessionId: "sess_parent" }

  it("the human operator (no caller session) passes", () => {
    expect(checkSessionOwnerGate({ callerSessionId: undefined, target, tool: "agent_prompt" })).toEqual({
      ok: true,
    })
  })

  it("the session itself passes", () => {
    expect(checkSessionOwnerGate({ callerSessionId: "sess_child", target, tool: "agent_prompt" })).toEqual({
      ok: true,
    })
  })

  it("the OWNER (the session that spawned it) passes", () => {
    expect(checkSessionOwnerGate({ callerSessionId: "sess_parent", target, tool: "agent_prompt" })).toEqual({
      ok: true,
    })
  })

  it("an UNRELATED agent session is refused", () => {
    const gate = checkSessionOwnerGate({ callerSessionId: "sess_stranger", target, tool: "agent_prompt" })
    expect(gate.ok).toBe(false)
    if (!gate.ok) expect(gate.message).toContain("allowPromptFrom")
  })

  it("a session named in `allowPromptFrom` passes; anything else still refused", () => {
    const allowed = { id: "sess_child", parentSessionId: "sess_parent", allowPromptFrom: ["sess_stranger"] }
    expect(
      checkSessionOwnerGate({ callerSessionId: "sess_stranger", target: allowed, tool: "agent_prompt" }),
    ).toEqual({ ok: true })
    expect(
      checkSessionOwnerGate({ callerSessionId: "sess_other", target: allowed, tool: "agent_prompt" }).ok,
    ).toBe(false)
  })

  it("the `any` wildcard allows any caller session", () => {
    const open = { id: "sess_child", parentSessionId: "sess_parent", allowPromptFrom: ["any"] }
    expect(
      checkSessionOwnerGate({ callerSessionId: "sess_whomever", target: open, tool: "agent_prompt" }),
    ).toEqual({ ok: true })
  })

  it("a depth-0 root spawn's owner is the operator — every agent caller refused", () => {
    const root = { id: "sess_root", parentSessionId: undefined }
    expect(
      checkSessionOwnerGate({ callerSessionId: "sess_stranger", target: root, tool: "agent_kill" }).ok,
    ).toBe(false)
  })

  describe("the policy editor gate", () => {
    const target2 = { id: "sess_child", parentSessionId: "sess_parent" }
    it("operator, self, and owner may change the policy; a stranger may not", () => {
      expect(checkPromptPolicyEditor({ callerSessionId: undefined, target: target2 })).toEqual({ ok: true })
      expect(checkPromptPolicyEditor({ callerSessionId: "sess_child", target: target2 })).toEqual({ ok: true })
      expect(checkPromptPolicyEditor({ callerSessionId: "sess_parent", target: target2 })).toEqual({ ok: true })
      expect(checkPromptPolicyEditor({ callerSessionId: "sess_stranger", target: target2 }).ok).toBe(false)
    })
  })
})

describe("session-owner gate over MCP", () => {
  it("a foreign session's agent_prompt is refused; the parent's is accepted", async () => {
    const { registry, parent, child } = await twoSessions()

    const strangerServer = new McpServer({ name: "stranger-server", version: "0.0.0" })
    registerAgentTools(strangerServer, { registry, callerSessionId: "sess_stranger" })
    const stranger = await connectClient(strangerServer)
    const refused = await callTool(stranger, "agent_prompt", { sessionId: child.id, prompt: "go" })
    expect(refused.isError).toBe(true)
    expect(refused.content?.[0]?.text).toContain("agent_prompt: session")
    expect(refused.content?.[0]?.text).toContain("sess_stranger")

    const strangerInterrupt = await callTool(stranger, "agent_interrupt", { sessionId: child.id })
    expect(strangerInterrupt.isError).toBe(true)
    const strangerKill = await callTool(stranger, "agent_kill", { sessionId: child.id })
    expect(strangerKill.isError).toBe(true)
    expect(strangerKill.content?.[0]?.text).toContain("agent_kill: session")

    const parentServer = new McpServer({ name: "parent-server", version: "0.0.0" })
    registerAgentTools(parentServer, { registry, callerSessionId: parent.id })
    const parentClient = await connectClient(parentServer)
    const accepted = await callTool(parentClient, "agent_prompt", { sessionId: child.id, prompt: "go" })
    expect(accepted.isError).toBeUndefined()
    expect(accepted.content?.[0]?.text).toContain('"ok": true')

    // The operator path (no callerSessionId at all) still works — full rights.
    const operatorServer = new McpServer({ name: "operator-server", version: "0.0.0" })
    registerAgentTools(operatorServer, { registry })
    const operator = await connectClient(operatorServer)
    const operatorCall = await callTool(operator, "agent_prompt", { sessionId: child.id, prompt: "go" })
    expect(operatorCall.isError).toBeUndefined()
    registry.shutdown()
  })

  it("`allowPromptFrom` grants a specific foreign session; the wildcard opens it to all", async () => {
    const granted = await twoSessions({ allowPromptFrom: ["sess_stranger"] })
    const grantedServer = new McpServer({ name: "granted-server", version: "0.0.0" })
    registerAgentTools(grantedServer, { registry: granted.registry, callerSessionId: "sess_stranger" })
    const grantedClient = await connectClient(grantedServer)
    const ok = await callTool(grantedClient, "agent_prompt", {
      sessionId: granted.child.id,
      prompt: "go",
    })
    expect(ok.isError).toBeUndefined()
    granted.registry.shutdown()

    const open = await twoSessions({ allowPromptFrom: ["any"] })
    const openServer = new McpServer({ name: "open-server", version: "0.0.0" })
    registerAgentTools(openServer, { registry: open.registry, callerSessionId: "sess_whomever" })
    const openClient = await connectClient(openServer)
    const ok2 = await callTool(openClient, "agent_prompt", { sessionId: open.child.id, prompt: "go" })
    expect(ok2.isError).toBeUndefined()
    open.registry.shutdown()
  })

  it("only the owner/session/operator may change `allowPromptFrom` (`agent_set_prompt_policy`)", async () => {
    const { registry, parent, child } = await twoSessions()

    const strangerServer = new McpServer({ name: "policy-stranger-server", version: "0.0.0" })
    registerAgentTools(strangerServer, { registry, callerSessionId: "sess_stranger" })
    const stranger = await connectClient(strangerServer)
    const refused = await callTool(stranger, "agent_set_prompt_policy", {
      sessionId: child.id,
      allowPromptFrom: ["sess_stranger"],
    })
    expect(refused.isError).toBe(true)
    expect(refused.content?.[0]?.text).toContain("sess_stranger")

    const parentServer = new McpServer({ name: "policy-parent-server", version: "0.0.0" })
    registerAgentTools(parentServer, { registry, callerSessionId: parent.id })
    const parentClient = await connectClient(parentServer)
    const ok = await callTool(parentClient, "agent_set_prompt_policy", {
      sessionId: child.id,
      allowPromptFrom: ["sess_stranger"],
    })
    expect(ok.isError).toBeUndefined()
    expect(JSON.parse(ok.content?.[0]?.text ?? "{}").allowPromptFrom).toEqual(["sess_stranger"])
    expect(registry.get(child.id)?.allowPromptFrom).toEqual(["sess_stranger"])

    // Operator may reset it.
    const operatorServer = new McpServer({ name: "policy-operator-server", version: "0.0.0" })
    registerAgentTools(operatorServer, { registry })
    const operator = await connectClient(operatorServer)
    const reset = await callTool(operator, "agent_set_prompt_policy", {
      sessionId: child.id,
      allowPromptFrom: [],
    })
    expect(reset.isError).toBeUndefined()
    expect(registry.get(child.id)?.allowPromptFrom).toBeUndefined()
    registry.shutdown()
  })

  it("received prompts record their caller (`session:prompt` events: sessionId or \"operator\")", async () => {
    const { registry, parent, child } = await twoSessions()
    const events: Array<{ type: string; sessionId: string; caller: string; queued?: boolean }> = []
    const bus: SessionEventBus = {
      emit(evt: SessionEvent) {
        if (evt.type === "session:prompt") {
          events.push({ type: evt.type, sessionId: evt.sessionId, caller: evt.caller, queued: evt.queued })
        }
      },
    } as unknown as SessionEventBus
    void bus

    // The event-bus wiring lives at registry construction; a second registry
    // with a bus exercises the recording path directly.
    const withBus = createSessionsRegistry({ persist: false, sessionEvents: bus })
    const wfParent = withBus
      .spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: instantAgentSession(),
        adapterSlug: "fake",
      })
      .id
    const wfChild = withBus
      .spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: instantAgentSession(),
        adapterSlug: "fake",
        parentSessionId: "sess_parent",
      })
      .id

    const server = new McpServer({ name: "caller-events-server", version: "0.0.0" })
    registerAgentTools(server, { registry: withBus, callerSessionId: "sess_parent" })
    const client = await connectClient(server)
    await callTool(client, "agent_prompt", { sessionId: wfChild, prompt: "go" })

    const operatorServer = new McpServer({ name: "caller-events-operator-server", version: "0.0.0" })
    registerAgentTools(operatorServer, { registry: withBus })
    const operator = await connectClient(operatorServer)
    await callTool(operator, "agent_prompt", { sessionId: wfChild, prompt: "go again" })

    const mine = events.filter(e => e.sessionId === wfChild)
    expect(mine).toHaveLength(2)
    expect(mine[0]).toEqual({ type: "session:prompt", sessionId: wfChild, caller: "sess_parent", queued: false })
    expect(mine[1]).toEqual({ type: "session:prompt", sessionId: wfChild, caller: "operator", queued: false })
    expect(events.every(e => e.type === "session:prompt")).toBe(true)
    void parent
    void registry
    registry.shutdown()
    withBus.shutdown()
  })
})
