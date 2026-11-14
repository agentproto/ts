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
import {
  checkOperatorLabelStamp,
  checkSessionOwnerGate,
  checkPromptPolicyEditor,
  matchesSessionGrant,
} from "../session-owner.js"
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

describe("matchesSessionGrant", () => {
  const labels: Record<string, string | undefined> = {
    sess_brain: "pygmalion-brain-persistent",
    sess_agent: "pygmalion-agent-alpha",
    sess_unlabeled: undefined,
  }
  const operatorLabelOf = (id: string) => labels[id]

  it("matches an exact session id", () => {
    expect(matchesSessionGrant(["sess_brain"], "sess_brain", operatorLabelOf)).toBe(true)
    expect(matchesSessionGrant(["sess_other"], "sess_brain", operatorLabelOf)).toBe(false)
  })

  it("matches an exact `label:` entry", () => {
    expect(
      matchesSessionGrant(["label:pygmalion-brain-persistent"], "sess_brain", operatorLabelOf),
    ).toBe(true)
    expect(
      matchesSessionGrant(["label:pygmalion-brain-other"], "sess_brain", operatorLabelOf),
    ).toBe(false)
  })

  it("matches a `label:<prefix>*` entry", () => {
    expect(matchesSessionGrant(["label:pygmalion-agent-*"], "sess_agent", operatorLabelOf)).toBe(
      true,
    )
    expect(matchesSessionGrant(["label:pygmalion-brain-*"], "sess_agent", operatorLabelOf)).toBe(
      false,
    )
  })

  it("`label:` / `label:*` with an empty prefix match nothing", () => {
    for (const entry of ["label:", "label:*"]) {
      expect(matchesSessionGrant([entry], "sess_brain", operatorLabelOf)).toBe(false)
    }
  })

  it("never matches the mutable `label`, only the operatorLabel", () => {
    // A caller that renamed itself carries no operatorLabel: no match.
    expect(matchesSessionGrant(["label:pygmalion-brain-persistent"], "sess_renamed", () => undefined)).toBe(false)
    expect(matchesSessionGrant(["label:pygmalion-brain-*"], "sess_unlabeled", operatorLabelOf)).toBe(false)
  })
})

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

  it("an ANCESTOR in the spawn tree keeps its control (scene: scoped orchestrator → grandchild)", () => {
    // Root A spawns B, B spawns C. A (the orchestrator root) driving C —
    // neither C's direct owner — is pre-existing subtree authority; the
    // owner gate must not revoke it.
    const ancestors = {
      "sess_c": "sess_b",
      "sess_b": "sess_a",
      "sess_a": undefined,
    } as Record<string, string | undefined>
    const target = { id: "sess_c", parentSessionId: "sess_b" }
    const parentOf = (id: string) => ancestors[id]
    expect(
      checkSessionOwnerGate({ callerSessionId: "sess_a", target, tool: "agent_prompt", parentOf }),
    ).toEqual({ ok: true })
    // A non-ancestor claimant is still refused.
    expect(
      checkSessionOwnerGate({ callerSessionId: "sess_stranger", target, tool: "agent_prompt", parentOf }).ok,
    ).toBe(false)
  })

  it("a depth-0 root spawn's owner is the operator — every agent caller refused", () => {
    const root = { id: "sess_root", parentSessionId: undefined }
    expect(
      checkSessionOwnerGate({ callerSessionId: "sess_stranger", target: root, tool: "agent_kill" }).ok,
    ).toBe(false)
  })

  describe("label-based `allowPromptFrom` grants", () => {
    const labels = {
      "sess_brain": "pygmalion-brain-persistent",
      "sess_agent_1": "pygmalion-agent-alpha",
      "sess_agent_2": "pygmalion-agent-beta",
      "sess_unlabeled": undefined,
    } as Record<string, string | undefined>
    const operatorLabelOf = (id: string) => labels[id]

    it("an exact `label:` entry allows a caller with that registered label", () => {
      const target = {
        id: "sess_child",
        parentSessionId: undefined,
        allowPromptFrom: ["label:pygmalion-brain-persistent"],
      }
      const gate = checkSessionOwnerGate({
        callerSessionId: "sess_brain",
        target,
        tool: "agent_prompt",
        operatorLabelOf,
      })
      expect(gate).toEqual({ ok: true })
    })

    it("a `label:<prefix>*` entry allows a caller whose label starts with the prefix", () => {
      const target = {
        id: "sess_child",
        parentSessionId: undefined,
        allowPromptFrom: ["label:pygmalion-agent-*"],
      }
      expect(
        checkSessionOwnerGate({ callerSessionId: "sess_agent_1", target, tool: "agent_prompt", operatorLabelOf }),
      ).toEqual({ ok: true })
      expect(
        checkSessionOwnerGate({ callerSessionId: "sess_agent_2", target, tool: "agent_prompt", operatorLabelOf }),
      ).toEqual({ ok: true })
    })

    it("a non-matching label is refused", () => {
      const target = { id: "sess_child", parentSessionId: undefined, allowPromptFrom: ["label:pygmalion-agent-*"] }
      expect(
        checkSessionOwnerGate({ callerSessionId: "sess_brain", target, tool: "agent_prompt", operatorLabelOf }).ok,
      ).toBe(false)
      expect(
        checkSessionOwnerGate({
          callerSessionId: "sess_other",
          target: { id: "sess_child", parentSessionId: undefined, allowPromptFrom: ["label:pygmalion-brain-persistent"] },
          tool: "agent_prompt",
          operatorLabelOf,
        }).ok,
      ).toBe(false)
    })

    it("a caller session whose label is missing never matches a `label:` entry", () => {
      const target = { id: "sess_child", parentSessionId: undefined, allowPromptFrom: ["label:pygmalion-agent-*"] }
      expect(
        checkSessionOwnerGate({ callerSessionId: "sess_unlabeled", target, tool: "agent_prompt", operatorLabelOf }).ok,
      ).toBe(false)
      expect(
        checkSessionOwnerGate({
          callerSessionId: "sess_unknown",
          target,
          tool: "agent_prompt",
          operatorLabelOf,
        }).ok,
      ).toBe(false)
    })

    it("raw ids and `any` still work alongside `label:` entries", () => {
      const raw = { id: "sess_child", parentSessionId: undefined, allowPromptFrom: ["sess_stranger"] }
      expect(checkSessionOwnerGate({ callerSessionId: "sess_stranger", target: raw, tool: "agent_prompt" })).toEqual({
        ok: true,
      })
      const open = { id: "sess_child", parentSessionId: undefined, allowPromptFrom: ["any"] }
      expect(
        checkSessionOwnerGate({ callerSessionId: "sess_whomever", target: open, tool: "agent_prompt" }),
      ).toEqual({ ok: true })
    })

    it("the default (no list) still refuses a foreign session", () => {
      const target = { id: "sess_child", parentSessionId: undefined }
      expect(
        checkSessionOwnerGate({ callerSessionId: "sess_brain", target, tool: "agent_prompt", operatorLabelOf }).ok,
      ).toBe(false)
    })

    it("a `label:` grant survives the granted caller's id changing (same label, new id)", () => {
      const target = {
        id: "sess_child",
        parentSessionId: undefined,
        allowPromptFrom: ["label:pygmalion-brain-persistent"],
      }
      // The brain restarted: a brand-new session id, same registered label.
      const restarted = { ...labels, "sess_brain_new": "pygmalion-brain-persistent" } as Record<string, string | undefined>
      expect(
        checkSessionOwnerGate({
          callerSessionId: "sess_brain_new",
          target,
          tool: "agent_prompt",
          operatorLabelOf: id => restarted[id],
        }),
      ).toEqual({ ok: true })
    })
  })

  describe("`label:` grants key on the immutable operatorLabel, never the mutable label", () => {
    const target = { id: "sess_child", parentSessionId: undefined, allowPromptFrom: ["label:pygmalion-brain-persistent"] }

    it("a caller that only RENAMED itself to the granted label (no operatorLabel) is refused", () => {
      // session_rename sets `label`, never `operatorLabel`.
      const res = checkSessionOwnerGate({
        callerSessionId: "sess_spoofer",
        target,
        tool: "agent_prompt",
        operatorLabelOf: () => undefined,
      })
      expect(res.ok).toBe(false)
    })

    it("a CHILD spawned by a session holding the label is refused (it has a parent)", () => {
      const parents: Record<string, string | undefined> = { sess_kid: "sess_brain" }
      const res = checkSessionOwnerGate({
        callerSessionId: "sess_kid",
        target,
        tool: "agent_prompt",
        parentOf: id => parents[id],
        operatorLabelOf: () => "pygmalion-brain-persistent",
      })
      expect(res.ok).toBe(false)
    })

    it("an operator-spawned root with the label is allowed (exact and prefix)", () => {
      const op = (id: string) => (id === "sess_brain" ? "pygmalion-brain-persistent" : undefined)
      const parentOf = () => undefined
      expect(
        checkSessionOwnerGate({ callerSessionId: "sess_brain", target, tool: "agent_prompt", parentOf, operatorLabelOf: op }),
      ).toEqual({ ok: true })
      expect(
        checkSessionOwnerGate({
          callerSessionId: "sess_brain",
          target: { ...target, allowPromptFrom: ["label:pygmalion-brain-*"] },
          tool: "agent_prompt",
          parentOf,
          operatorLabelOf: op,
        }),
      ).toEqual({ ok: true })
    })

    it("`label:` and `label:*` (empty prefix) match nothing", () => {
      for (const entry of ["label:", "label:*"]) {
        expect(
          checkSessionOwnerGate({
            callerSessionId: "sess_brain",
            target: { ...target, allowPromptFrom: [entry] },
            tool: "agent_prompt",
            operatorLabelOf: () => "pygmalion-brain-persistent",
          }).ok,
        ).toBe(false)
      }
    })
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

  const spawnRoot = (registry: ReturnType<typeof createSessionsRegistry>, parentSessionId?: string) =>
    registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
      ...(parentSessionId ? { parentSessionId } : {}),
    })
  const connectAs = async (
    registry: ReturnType<typeof createSessionsRegistry>,
    callerSessionId?: string,
  ): Promise<Client> => {
    const server = new McpServer({ name: `label-${callerSessionId ?? "operator"}`, version: "0.0.0" })
    registerAgentTools(server, { registry, ...(callerSessionId ? { callerSessionId } : {}) })
    return connectClient(server)
  }

  it("`agent_set_operator_label`: the human operator may stamp, trim and clear any session's label", async () => {
    const { registry, child } = await twoSessions()
    const operator = await connectAs(registry)
    const ok = await callTool(operator, "agent_set_operator_label", {
      sessionId: child.id,
      operatorLabel: "pygmalion-brain-persistent",
    })
    expect(ok.isError).toBeUndefined()
    expect(JSON.parse(ok.content?.[0]?.text ?? "{}").operatorLabel).toBe("pygmalion-brain-persistent")
    expect(registry.get(child.id)?.operatorLabel).toBe("pygmalion-brain-persistent")

    // Surrounding whitespace is trimmed (a padded label would never match an
    // exact `label:<x>` grant).
    const padded = await callTool(operator, "agent_set_operator_label", {
      sessionId: child.id,
      operatorLabel: "  pygmalion-brain-persistent  ",
    })
    expect(padded.isError).toBeUndefined()
    expect(registry.get(child.id)?.operatorLabel).toBe("pygmalion-brain-persistent")

    // A whitespace-only label clears it, same as an empty string.
    const whitespace = await callTool(operator, "agent_set_operator_label", {
      sessionId: child.id,
      operatorLabel: "   ",
    })
    expect(whitespace.isError).toBeUndefined()
    expect(registry.get(child.id)?.operatorLabel).toBeUndefined()

    await callTool(operator, "agent_set_operator_label", { sessionId: child.id, operatorLabel: "x" })
    const cleared = await callTool(operator, "agent_set_operator_label", {
      sessionId: child.id,
      operatorLabel: "",
    })
    expect(cleared.isError).toBeUndefined()
    expect(registry.get(child.id)?.operatorLabel).toBeUndefined()
    registry.shutdown()
  })

  it("`agent_set_operator_label`: a session stamps its direct child and its descendants, never itself", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const root = spawnRoot(registry)
    const child = spawnRoot(registry, root.id)
    const grandchild = spawnRoot(registry, child.id)

    // The owner (parent) labels its child.
    const asRoot = await connectAs(registry, root.id)
    const ok = await callTool(asRoot, "agent_set_operator_label", {
      sessionId: child.id,
      operatorLabel: "worker-1",
    })
    expect(ok.isError).toBeUndefined()
    expect(registry.get(child.id)?.operatorLabel).toBe("worker-1")

    // An ancestor labels a transitive descendant (same notion of owner as the drive gate).
    const deep = await callTool(asRoot, "agent_set_operator_label", {
      sessionId: grandchild.id,
      operatorLabel: "worker-2",
    })
    expect(deep.isError).toBeUndefined()
    expect(registry.get(grandchild.id)?.operatorLabel).toBe("worker-2")

    // The owner clears it again.
    const cleared = await callTool(asRoot, "agent_set_operator_label", { sessionId: child.id, operatorLabel: "" })
    expect(cleared.isError).toBeUndefined()
    expect(registry.get(child.id)?.operatorLabel).toBeUndefined()

    // A session may not stamp its own label, nor its owner's.
    const asChild = await connectAs(registry, child.id)
    const self = await callTool(asChild, "agent_set_operator_label", {
      sessionId: child.id,
      operatorLabel: "mine",
    })
    expect(self.isError).toBe(true)
    expect(self.content?.[0]?.text).toContain("may not stamp its own operatorLabel")
    expect(registry.get(child.id)?.operatorLabel).toBeUndefined()
    const up = await callTool(asChild, "agent_set_operator_label", {
      sessionId: root.id,
      operatorLabel: "boss",
    })
    expect(up.isError).toBe(true)
    expect(registry.get(root.id)?.operatorLabel).toBeUndefined()
    registry.shutdown()
  })

  it("`agent_set_operator_label`: a session may not label a session it does not own, even one it may prompt", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const owner = spawnRoot(registry)
    const stranger = spawnRoot(registry)
    const target = spawnRoot(registry, owner.id)
    // `allowPromptFrom` lets the stranger DRIVE the target; it does not own it.
    registry.setPromptPolicy(target.id, [stranger.id])
    const asStranger = await connectAs(registry, stranger.id)
    const refused = await callTool(asStranger, "agent_set_operator_label", {
      sessionId: target.id,
      operatorLabel: "hijack",
    })
    expect(refused.isError).toBe(true)
    expect(refused.content?.[0]?.text).toContain("not owned by the caller")
    expect(registry.get(target.id)?.operatorLabel).toBeUndefined()
    registry.shutdown()
  })

  it("`agent_set_operator_label`: the shared claude-desktop identity labels a child declared under a cc: parent", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const declared = spawnRoot(registry, "cc:abc123")
    registry.setPromptPolicy(declared.id, ["claude-desktop"])
    const optedOut = spawnRoot(registry, "cc:abc123")
    const nonCc = spawnRoot(registry)
    registry.setPromptPolicy(nonCc.id, ["claude-desktop"])

    const desktop = await connectAs(registry, "claude-desktop")
    const ok = await callTool(desktop, "agent_set_operator_label", {
      sessionId: declared.id,
      operatorLabel: "desk-worker",
    })
    expect(ok.isError).toBeUndefined()
    expect(registry.get(declared.id)?.operatorLabel).toBe("desk-worker")

    // No recorded claude-desktop grant (opt-out), or no cc: declared parent: refused.
    for (const target of [optedOut, nonCc]) {
      const refused = await callTool(desktop, "agent_set_operator_label", {
        sessionId: target.id,
        operatorLabel: "nope",
      })
      expect(refused.isError, target.id).toBe(true)
    }

    // Another identity is not the desktop, even when the child names a cc: parent.
    const other = await connectAs(registry, "someone-else")
    const refused = await callTool(other, "agent_set_operator_label", {
      sessionId: declared.id,
      operatorLabel: "nope",
    })
    expect(refused.isError).toBe(true)
    registry.shutdown()
  })

  it("`agent_set_operator_label`: refuses a label another LIVE session already carries (session callers)", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const root = spawnRoot(registry)
    const other = spawnRoot(registry)
    const a = spawnRoot(registry, root.id)
    const b = spawnRoot(registry, root.id)
    const operator = await connectAs(registry)
    await callTool(operator, "agent_set_operator_label", { sessionId: other.id, operatorLabel: "taken" })

    const asRoot = await connectAs(registry, root.id)
    const clash = await callTool(asRoot, "agent_set_operator_label", { sessionId: a.id, operatorLabel: "taken" })
    expect(clash.isError).toBe(true)
    expect(clash.content?.[0]?.text).toContain(`already carried by session "${other.id}" (status: running)`)
    expect(registry.get(a.id)?.operatorLabel).toBeUndefined()

    // A free label works; re-stamping the same session with its own label is not a clash.
    const first = await callTool(asRoot, "agent_set_operator_label", { sessionId: a.id, operatorLabel: "free" })
    expect(first.isError).toBeUndefined()
    const again = await callTool(asRoot, "agent_set_operator_label", { sessionId: a.id, operatorLabel: "free" })
    expect(again.isError).toBeUndefined()
    // ...but a sibling may not take it.
    const sibling = await callTool(asRoot, "agent_set_operator_label", { sessionId: b.id, operatorLabel: "free" })
    expect(sibling.isError).toBe(true)

    // A DEAD holder keeps its name (the brain between two restarts): still refused,
    // and the error names the holder's status.
    registry.kill(other.id)
    const dead = await callTool(asRoot, "agent_set_operator_label", { sessionId: b.id, operatorLabel: "taken" })
    expect(dead.isError).toBe(true)
    expect(dead.content?.[0]?.text).toContain(`session "${other.id}" (status: killed)`)
    expect(registry.get(b.id)?.operatorLabel).toBeUndefined()

    // The human operator is exempt from the check.
    const byOperator = await callTool(operator, "agent_set_operator_label", { sessionId: b.id, operatorLabel: "taken" })
    expect(byOperator.isError).toBeUndefined()
    await callTool(operator, "agent_set_operator_label", { sessionId: b.id, operatorLabel: "" })

    // Archiving the dead holder frees the name.
    registry.archiveSession(other.id)
    const reuse = await callTool(asRoot, "agent_set_operator_label", { sessionId: b.id, operatorLabel: "taken" })
    expect(reuse.isError).toBeUndefined()
    registry.shutdown()
  })

  it("`agent_set_operator_label`: a killed holder still blocks the label; a predecessor of the target does not", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const root = spawnRoot(registry)
    const brain = spawnRoot(registry)
    const kid = spawnRoot(registry, root.id)
    const operator = await connectAs(registry)
    await callTool(operator, "agent_set_operator_label", { sessionId: brain.id, operatorLabel: "brain" })
    registry.kill(brain.id)
    const asRoot = await connectAs(registry, root.id)
    const refused = await callTool(asRoot, "agent_set_operator_label", { sessionId: kid.id, operatorLabel: "brain" })
    expect(refused.isError).toBe(true)

    // A predecessor row whose continuation chain ends at the target is the same lineage.
    const old = spawnRoot(registry, root.id)
    const successor = spawnRoot(registry, root.id)
    await callTool(operator, "agent_set_operator_label", { sessionId: old.id, operatorLabel: "lineage" })
    registry.kill(old.id)
    ;(registry.get(old.id) as { continuedTo?: string }).continuedTo = successor.id
    const same = await callTool(asRoot, "agent_set_operator_label", { sessionId: successor.id, operatorLabel: "lineage" })
    expect(same.isError).toBeUndefined()
    registry.shutdown()
  })

  it("a label an owner stamped on a child is an address, never a grant", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const root = spawnRoot(registry)
    const child = spawnRoot(registry, root.id)
    const target = spawnRoot(registry)
    registry.setPromptPolicy(target.id, ["label:bridge"])

    const asRoot = await connectAs(registry, root.id)
    const stamped = await callTool(asRoot, "agent_set_operator_label", {
      sessionId: child.id,
      operatorLabel: "bridge",
    })
    expect(stamped.isError).toBeUndefined()

    // The child carries `bridge` yet `label:bridge` in the target's allowPromptFrom ignores it.
    const asChild = await connectAs(registry, child.id)
    const driven = await callTool(asChild, "agent_prompt", { sessionId: target.id, prompt: "go" })
    expect(driven.isError).toBe(true)
    expect(registry.get(target.id)?.status).not.toBe("killed")

    // The same label on a ROOT (operator-stamped) session is still a valid grant.
    const operator = await connectAs(registry)
    const brain = spawnRoot(registry)
    await callTool(operator, "agent_set_operator_label", { sessionId: brain.id, operatorLabel: "bridge2" })
    registry.setPromptPolicy(target.id, ["label:bridge2"])
    const asBrain = await connectAs(registry, brain.id)
    const ok = await callTool(asBrain, "agent_prompt", { sessionId: target.id, prompt: "go" })
    expect(ok.isError).toBeUndefined()
    registry.shutdown()
  })

  it("a spawn-tree ANCESTOR drives a transitive descendant over MCP (grandchild)", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const a = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
    })
    const b = registry
      .spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: instantAgentSession(),
        adapterSlug: "fake",
        parentSessionId: a.id,
      })
      .id
    const c = registry
      .spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: instantAgentSession(),
        adapterSlug: "fake",
        parentSessionId: b,
      })
      .id

    const rootServer = new McpServer({ name: "ancestor-server", version: "0.0.0" })
    registerAgentTools(rootServer, { registry, callerSessionId: a.id })
    const root = await connectClient(rootServer)
    const ok = await callTool(root, "agent_prompt", { sessionId: c, prompt: "go" })
    expect(ok.isError).toBeUndefined()

    // The direct-child gate still applies to a NON-ancestor spawn.
    const bServer = new McpServer({ name: "sibling-server", version: "0.0.0" })
    registerAgentTools(bServer, { registry, callerSessionId: b })
    const bClient = await connectClient(bServer)
    const strangerTarget = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: instantAgentSession(),
      adapterSlug: "fake",
    })
    const refused = await callTool(bClient, "agent_prompt", { sessionId: strangerTarget.id, prompt: "go" })
    expect(refused.isError).toBe(true)
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

describe("checkOperatorLabelStamp", () => {
  const parents: Record<string, string | undefined> = { child: "root", grandchild: "child" }
  const parentOf = (id: string) => parents[id]

  it("operator: allowed; self: refused; parent and ancestor: allowed; others: refused", () => {
    const target = { id: "child", parentSessionId: "root" }
    expect(checkOperatorLabelStamp({ callerSessionId: undefined, target, parentOf }).ok).toBe(true)
    expect(checkOperatorLabelStamp({ callerSessionId: "child", target, parentOf }).ok).toBe(false)
    expect(checkOperatorLabelStamp({ callerSessionId: "root", target, parentOf }).ok).toBe(true)
    expect(
      checkOperatorLabelStamp({ callerSessionId: "root", target: { id: "grandchild", parentSessionId: "child" }, parentOf }).ok,
    ).toBe(true)
    expect(checkOperatorLabelStamp({ callerSessionId: "stranger", target, parentOf }).ok).toBe(false)
  })

  it("`allowPromptFrom: any` or a listed id is not ownership", () => {
    const target = { id: "child", parentSessionId: "root", allowPromptFrom: ["any", "stranger"] }
    expect(checkOperatorLabelStamp({ callerSessionId: "stranger", target, parentOf }).ok).toBe(false)
  })
})

describe("a label on a session with a parent is never a grant", () => {
  const labels: Record<string, string | undefined> = { kid: "bridge", boss: "bridge" }
  const parents: Record<string, string | undefined> = { kid: "root" }
  const operatorLabelOf = (id: string) => labels[id]
  const parentOf = (id: string) => parents[id]

  it("matchesSessionGrant: `label:` entries match a root only when parentOf is given", () => {
    expect(matchesSessionGrant(["label:bridge"], "boss", operatorLabelOf, parentOf)).toBe(true)
    expect(matchesSessionGrant(["label:bridge"], "kid", operatorLabelOf, parentOf)).toBe(false)
    expect(matchesSessionGrant(["label:br*"], "kid", operatorLabelOf, parentOf)).toBe(false)
    // An exact session id entry still names a child.
    expect(matchesSessionGrant(["kid"], "kid", operatorLabelOf, parentOf)).toBe(true)
  })

  it("checkSessionOwnerGate: allowPromptFrom `label:` admits the labelled root, not the labelled child", () => {
    const target = { id: "t", parentSessionId: undefined, allowPromptFrom: ["label:bridge"] }
    const gate = (callerSessionId: string) =>
      checkSessionOwnerGate({ callerSessionId, target, tool: "agent_prompt", parentOf, operatorLabelOf }).ok
    expect(gate("boss")).toBe(true)
    expect(gate("kid")).toBe(false)
  })
})
