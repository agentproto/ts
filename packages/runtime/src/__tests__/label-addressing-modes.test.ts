/**
 * `defaults.messaging.labelAddressing` (open | tree | operator, default tree)
 * and the per-session `agent_start.labelAddressing`: who may reach a session
 * by `label:<x>`, and who may take the name.
 */
import { afterEach, describe, expect, it } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { registerAgentTools } from "../agent-tools.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import { resolveMessagingDefaults } from "../messaging-defaults.js"
import { registerMessageTools, resolveLiveLabelAddress } from "../message-tools.js"

type Mode = "open" | "tree" | "operator"

const idle = () => ({
  sessionId: "idle",
  async *send() {
    yield { kind: "turn-end", reason: "completed" } as const
  },
  async cancel() {},
  async close() {},
})

let registries: SessionsRegistry[] = []
afterEach(() => {
  for (const r of registries) r.shutdown()
  registries = []
})

function world() {
  const registry = createSessionsRegistry({ persist: false })
  registries.push(registry)
  const spawn = (parentSessionId?: string, label?: string, mode?: Mode) => {
    const d = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: idle() as never,
      adapterSlug: "fake",
      ...(parentSessionId ? { parentSessionId } : {}),
    })
    if (label) registry.setOperatorLabel(d.id, label)
    if (mode) registry.setLabelAddressing(d.id, mode)
    return d
  }
  return { registry, spawn }
}

/** Resolve `label:<x>` as `callerId` under a daemon default `mode`. */
function resolve(registry: SessionsRegistry, callerId: string | undefined, label: string, mode?: Mode) {
  return resolveLiveLabelAddress({
    registry,
    tool: "t",
    to: `label:${label}`,
    mayReach: () => true,
    ...(callerId ? { callerId } : {}),
    ...(mode ? { defaultMode: mode } : {}),
  })
}
const idOf = (r: ReturnType<typeof resolve>) => ("id" in r ? r.id : JSON.parse(r.content[0]!.text).error)

describe("label addressing: resolution", () => {
  it("default is tree: parent and siblings resolve a child's label, an outsider does not", () => {
    const { registry, spawn } = world()
    const parent = spawn()
    const bass = spawn(parent.id, "bass")
    const drums = spawn(parent.id, "drums")
    const outsider = spawn()
    expect(idOf(resolve(registry, parent.id, "bass"))).toBe(bass.id)
    expect(idOf(resolve(registry, drums.id, "bass"))).toBe(bass.id)
    expect(idOf(resolve(registry, outsider.id, "bass"))).toBe("no_live_session_for_label")
    expect(idOf(resolve(registry, undefined, "bass"))).toBe("no_live_session_for_label")
    // The child does not address itself by name.
    expect(idOf(resolve(registry, bass.id, "bass"))).toBe("no_live_session_for_label")
  })

  it("tree: a name used in two families stays separate for each family", () => {
    const { registry, spawn } = world()
    const p1 = spawn()
    const p2 = spawn()
    const a = spawn(p1.id, "bass")
    const b = spawn(p2.id, "bass")
    const sib1 = spawn(p1.id)
    const sib2 = spawn(p2.id)
    expect(idOf(resolve(registry, sib1.id, "bass"))).toBe(a.id)
    expect(idOf(resolve(registry, sib2.id, "bass"))).toBe(b.id)
  })

  it("tree: an outsider cannot impersonate by giving itself the family's name (it is not addressable from the family)", () => {
    const { registry, spawn } = world()
    const parent = spawn()
    const real = spawn(parent.id, "bass")
    const sibling = spawn(parent.id)
    const outsider = spawn()
    const fake = spawn(outsider.id, "bass") // a child of the outsider's own family
    expect(idOf(resolve(registry, sibling.id, "bass"))).toBe(real.id)
    expect(idOf(resolve(registry, outsider.id, "bass"))).toBe(fake.id)
  })

  it("operator: a child's label resolves for everyone (previous behaviour)", () => {
    const { registry, spawn } = world()
    const parent = spawn()
    const bass = spawn(parent.id, "bass")
    const outsider = spawn()
    expect(idOf(resolve(registry, outsider.id, "bass", "operator"))).toBe(bass.id)
    expect(idOf(resolve(registry, undefined, "bass", "operator"))).toBe(bass.id)
  })

  it("open: everyone resolves, and a clash is ambiguous_label", () => {
    const { registry, spawn } = world()
    const p1 = spawn()
    const p2 = spawn()
    const a = spawn(p1.id, "bass")
    const outsider = spawn()
    expect(idOf(resolve(registry, outsider.id, "bass", "open"))).toBe(a.id)
    spawn(p2.id, "bass")
    expect(idOf(resolve(registry, outsider.id, "bass", "open"))).toBe("ambiguous_label")
  })

  it("a per-session policy overrides the daemon default", () => {
    const { registry, spawn } = world()
    const parent = spawn()
    const open = spawn(parent.id, "bass", "open")
    const outsider = spawn()
    expect(idOf(resolve(registry, outsider.id, "bass", "tree"))).toBe(open.id)
    const closed = spawn(parent.id, "drums", "tree")
    expect(idOf(resolve(registry, outsider.id, "drums", "open"))).toBe("no_live_session_for_label")
    expect(idOf(resolve(registry, parent.id, "drums", "open"))).toBe(closed.id)
  })

  it("root (operator-stamped) labels stay global in every mode", () => {
    const { registry, spawn } = world()
    const brain = spawn(undefined, "brain")
    const other = spawn()
    for (const mode of ["open", "tree", "operator"] as const) {
      expect(idOf(resolve(registry, other.id, "brain", mode))).toBe(brain.id)
    }
  })
})

async function connect(registry: SessionsRegistry, callerSessionId: string, mode?: Mode) {
  const server = new McpServer({ name: "label-modes", version: "0.0.0" })
  const resolveAgentAdapter: AgentAdapterResolver = async () => ({
    startSession: (async () => idle()) as never,
    commandPreview: "mock-adapter",
  })
  registerAgentTools(server, {
    registry,
    resolveAgentAdapter,
    callerSessionId,
    ...(mode ? { messagingLabelAddressing: mode } : {}),
  })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: "c", version: "0" })
  await client.connect(ct)
  return async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> }
    return { isError: r.isError === true, text: r.content[0]!.text }
  }
}

describe("label addressing: setting a label", () => {
  it("agent_set_operator_label: a sibling name clash is refused in tree, allowed in open, global in operator", async () => {
    const { registry, spawn } = world()
    const parent = spawn()
    spawn(parent.id, "bass")
    const drums = spawn(parent.id)
    const call = await connect(registry, parent.id)
    const clash = await call("agent_set_operator_label", { sessionId: drums.id, operatorLabel: "bass" })
    expect(clash.isError).toBe(true)
    expect(clash.text).toContain("already carried")
    // Same name in another family is fine under tree.
    const otherParent = spawn()
    const otherChild = spawn(otherParent.id)
    const asOther = await connect(registry, otherParent.id)
    expect((await asOther("agent_set_operator_label", { sessionId: otherChild.id, operatorLabel: "bass" })).isError).toBe(false)
    // open: no uniqueness check.
    const asParentOpen = await connect(registry, parent.id, "open")
    expect((await asParentOpen("agent_set_operator_label", { sessionId: drums.id, operatorLabel: "bass" })).isError).toBe(false)
    // operator: the global check applies, so the name is taken everywhere.
    const third = spawn(otherParent.id)
    const asOtherOperator = await connect(registry, otherParent.id, "operator")
    expect((await asOtherOperator("agent_set_operator_label", { sessionId: third.id, operatorLabel: "bass" })).isError).toBe(true)
  })

  it("agent_start: a second child with the same label in the family is not stamped (collision refused) under tree, stamped under open", async () => {
    for (const [mode, secondStamped] of [["tree", false], ["open", true]] as const) {
      const { registry, spawn } = world()
      const parent = spawn()
      const call = await connect(registry, parent.id, mode)
      for (let i = 0; i < 2; i++) {
        const r = await call("agent_start", { adapter: "claude-code", prompt: "hi", cwd: "/tmp", label: "bass", dedupe: false })
        expect(r.isError).toBe(false)
      }
      const kids = registry.list().filter(d => d.parentSessionId === parent.id)
      expect(kids).toHaveLength(2)
      expect(kids.filter(k => k.operatorLabel === "bass")).toHaveLength(secondStamped ? 2 : 1)
    }
  })

  it("only the parent can set a family name: a sibling cannot label another sibling", async () => {
    const { registry, spawn } = world()
    const parent = spawn()
    const a = spawn(parent.id)
    const b = spawn(parent.id)
    const asA = await connect(registry, a.id)
    const r = await asA("agent_set_operator_label", { sessionId: b.id, operatorLabel: "bass" })
    expect(r.isError).toBe(true)
    expect(registry.get(b.id)?.operatorLabel).toBeUndefined()
  })

  it("agent_start by a session: label becomes a family name (tree), stays unstamped under operator, per-session override wins", async () => {
    for (const [mode, perSession, expectStamped] of [
      ["tree", undefined, true],
      ["open", undefined, true],
      ["operator", undefined, false],
      ["operator", "tree", true],
      ["tree", "operator", false],
    ] as const) {
      const { registry, spawn } = world()
      const parent = spawn()
      const call = await connect(registry, parent.id, mode)
      const r = await call("agent_start", {
        adapter: "claude-code",
        prompt: "hi",
        cwd: "/tmp",
        label: "bass",
        ...(perSession ? { labelAddressing: perSession } : {}),
      })
      expect(r.isError).toBe(false)
      const started = registry.list().find(d => d.parentSessionId === parent.id)
      expect(started).toBeDefined()
      expect(started!.operatorLabel).toBe(expectStamped ? "bass" : undefined)
      if (perSession) expect(started!.labelAddressing).toBe(perSession)
    }
  })
})

describe("label addressing: daemon config", () => {
  it("defaults to tree and reads defaults.messaging.labelAddressing", async () => {
    expect((await resolveMessagingDefaults(async () => ({}))).labelAddressing).toBe("tree")
    for (const mode of ["open", "tree", "operator"] as const) {
      const d = await resolveMessagingDefaults(async () => ({ defaults: { messaging: { labelAddressing: mode } } }))
      expect(d.labelAddressing).toBe(mode)
    }
  })
})

describe("label addressing: message_send", () => {
  async function sendAs(registry: SessionsRegistry, callerId: string, to: string, mode?: Mode) {
    const server = new McpServer({ name: "label-send", version: "0.0.0" })
    registerMessageTools(server, { registry, callerSessionId: callerId, allowSiblings: true, allowSameWorkspace: true, ...(mode ? { labelAddressing: mode } : {}) })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const client = new Client({ name: "c", version: "0" })
    await client.connect(ct)
    const r = (await client.callTool({ name: "message_send", arguments: { to, text: "hi" } })) as { content: Array<{ text: string }> }
    return JSON.parse(r.content[0]!.text) as Record<string, any>
  }

  it("tree (default): a sibling reaches label:bass, an outsider gets no_live_session_for_label; operator and open let the outsider through", async () => {
    const { registry, spawn } = world()
    const parent = spawn()
    const bass = spawn(parent.id, "bass")
    const drums = spawn(parent.id)
    const outsider = spawn()
    expect(await sendAs(registry, drums.id, "label:bass")).toMatchObject({ ok: true, to: bass.id })
    expect(await sendAs(registry, parent.id, "label:bass")).toMatchObject({ ok: true, to: bass.id })
    expect(await sendAs(registry, outsider.id, "label:bass")).toMatchObject({ ok: false, error: "no_live_session_for_label" })
    for (const mode of ["operator", "open"] as const) {
      expect(await sendAs(registry, outsider.id, "label:bass", mode)).toMatchObject({ ok: true, to: bass.id })
    }
  })
})
