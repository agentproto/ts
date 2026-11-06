/**
 * A reply to a message you received is always possible (rule `messaging.reply`),
 * even when the original sender is an unverified `claude-desktop` / `cc:` row
 * with no tree or workspace relation. Fake or foreign `replyTo` opens nothing;
 * the reply never interrupts.
 *
 *  - "label" (default): delivered, text prefixed `[unverified sender: ...] `,
 *    capped at steer (an interrupt request degrades to steer, never refused).
 *  - "block": the unverified session sender keeps `forbidden_recipient`.
 *  - A verified unrelated sender is refused whatever the knob says.
 *  - `agent_prompt` (session.drive) stays strict for an unverified sender.
 */

import { describe, it, expect, vi } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerMessageTools } from "../message-tools.js"
import { createSessionMessage } from "../session-message.js"
import { decide } from "../permissions.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent, SessionDescriptor } from "../sessions.js"

function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: "acp_test",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

function spawnNode(registry: SessionsRegistry, workspaceSlug: string, label: string): SessionDescriptor {
  return registry.spawnAgent({
    workspaceSlug,
    cwd: "/tmp",
    agentSession: fakeAgentSession(),
    adapterSlug: "mock",
    label,
    depth: 0,
  })
}

async function harness(opts: {
  registry: SessionsRegistry
  callerSessionId?: string
  anonymousSend?: "block" | "label"
  noCallerIdentity?: "accept"
  allowInterrupt?: boolean
}) {
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  registerMessageTools(server, {
    registry: opts.registry,
    ...(opts.callerSessionId ? { callerSessionId: opts.callerSessionId } : {}),
    allowSameWorkspace: false,
    ...(opts.anonymousSend ? { anonymousSend: opts.anonymousSend } : {}),
    ...(opts.noCallerIdentity ? { noCallerIdentity: opts.noCallerIdentity } : {}),
    ...(opts.allowInterrupt ? { allowInterrupt: true } : {}),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)
  return { client, close: async () => client.close() }
}

const textOf = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0]!.text
const isError = (r: unknown): boolean => (r as { isError?: boolean }).isError === true


function world(extId: string, host: string) {
  const registry = createSessionsRegistry({ persist: false })
  const brain = spawnNode(registry, "agentik-studio", "brain")
  vi.spyOn(registry, "enqueuePrompt").mockResolvedValue({ queued: false })
  registry.touchExternal({ id: extId, host })
  const send = vi.spyOn(registry, "sendMessage")
  return { registry, brain, send }
}

/** Put a message from `fromId` into the brain's inbox, as a real delivery would. */
async function receive(registry: SessionsRegistry, brainId: string, fromId: string) {
  const h = await harness({ registry, callerSessionId: fromId, anonymousSend: "label" })
  try {
    const r = await h.client.callTool({ name: "message_send", arguments: { to: brainId, text: "ping" } })
    return JSON.parse(textOf(r)).messageId as string
  } finally {
    await h.close()
  }
}

for (const [extId, host] of [
  ["claude-desktop", "claude-desktop"],
  ["cc:6ffcb38d-38ff-4f00-b680-2cf7eed64902", "claude-code"],
] as const) {
  describe(`reply to ${extId}`, () => {
    it("message_send with a valid replyTo is delivered, never interrupts", async () => {
      const { registry, brain, send } = world(extId, host)
      const id = await receive(registry, brain.id, extId)
      send.mockClear()
      const h = await harness({ registry, callerSessionId: brain.id, allowInterrupt: true })
      try {
        const r = await h.client.callTool({
          name: "message_send",
          arguments: { to: extId, text: "answer", replyTo: id, urgency: "interrupt" },
        })
        expect(isError(r)).toBeFalsy()
        expect(JSON.parse(textOf(r))).toMatchObject({ ok: true, to: extId })
        expect(send).toHaveBeenCalledTimes(1)
        expect(send.mock.calls[0]![0]).toMatchObject({ to: extId, replyTo: id })
        // No interrupt grant is passed down (an external row has no turn to cut).
        expect(send.mock.calls[0]![1]?.allowInterrupt).not.toBe(true)
      } finally {
        await h.close()
      }
    })

    it("labels the reply as unverified when the original came from an unverified sender", async () => {
      const { registry, brain, send } = world(extId, host)
      const id = await receive(registry, brain.id, extId)
      send.mockClear()
      const h = await harness({ registry, callerSessionId: brain.id })
      try {
        const r = await h.client.callTool({ name: "message_send", arguments: { to: extId, text: "answer", replyTo: id } })
        expect(JSON.parse(textOf(r))).toMatchObject({ ok: true, unverified: true })
        expect(send.mock.calls[0]![0].text).toMatch(/^\[unverified sender: .+\] answer$/)
      } finally {
        await h.close()
      }
    })

    it("message_reply is delivered too", async () => {
      const { registry, brain, send } = world(extId, host)
      const id = await receive(registry, brain.id, extId)
      send.mockClear()
      const h = await harness({ registry, callerSessionId: brain.id })
      try {
        const r = await h.client.callTool({ name: "message_reply", arguments: { replyTo: id, text: "answer" } })
        expect(isError(r)).toBeFalsy()
        expect(send).toHaveBeenCalledTimes(1)
      } finally {
        await h.close()
      }
    })

    it("a made-up replyTo stays forbidden_recipient", async () => {
      const { registry, brain, send } = world(extId, host)
      const h = await harness({ registry, callerSessionId: brain.id })
      try {
        const r = await h.client.callTool({
          name: "message_send",
          arguments: { to: extId, text: "x", replyTo: "msg_doesnotexist" },
        })
        expect(isError(r)).toBe(true)
        expect(JSON.parse(textOf(r)).error).toBe("forbidden_recipient")
        expect(send).not.toHaveBeenCalled()
      } finally {
        await h.close()
      }
    })

    it("a replyTo whose original sender is not `to` stays refused", async () => {
      const { registry, brain, send } = world(extId, host)
      const other = spawnNode(registry, "agentik-studio", "colleague")
      const id = await receive(registry, brain.id, other.id)
      send.mockClear()
      const h = await harness({ registry, callerSessionId: brain.id })
      try {
        const r = await h.client.callTool({
          name: "message_send",
          arguments: { to: extId, text: "x", replyTo: id },
        })
        expect(isError(r)).toBe(true)
        expect(JSON.parse(textOf(r)).error).toBe("forbidden_recipient")
        expect(send).not.toHaveBeenCalled()
      } finally {
        await h.close()
      }
    })
  })
}

describe("reply to a verified original sender", () => {
  it("stays unlabelled", async () => {
    const { registry, brain, send } = world("claude-desktop", "claude-desktop")
    const peer = spawnNode(registry, "other-workspace", "peer")
    // peer messages the brain through the Registry directly (verified, relation granted in same-workspace-less setup).
    const m = createSessionMessage({ to: brain.id, from: { sessionId: peer.id, relation: "granted" }, text: "hi" })
    await registry.sendMessage(m, { source: "t", origin: "t" })
    send.mockClear()
    const h = await harness({ registry, callerSessionId: brain.id })
    try {
      const r = await h.client.callTool({ name: "message_send", arguments: { to: peer.id, text: "answer", replyTo: m.id } })
      expect(isError(r)).toBeFalsy()
      expect(send.mock.calls[0]![0].text).toBe("answer")
    } finally {
      await h.close()
    }
  })
})

describe("reply rule is capped at steer in the ACL", () => {
  it("session.message.interrupt is refused for a reply-admitted message", () => {
    const { registry, brain } = world("claude-desktop", "claude-desktop")
    const ext = registry.get("claude-desktop")!
    const ctx = {
      messaging: { anonymousSend: "block" as const, agentInterrupt: "allow" as const },
      parentOf: (id: string) => registry.get(id)?.parentSessionId,
      reply: { messageId: "msg_a", originalSenderOf: () => "claude-desktop" },
    }
    const res = { kind: "session", session: ext } as const
    expect(decide({ kind: "session", session: brain }, "session.message", res, ctx)).toMatchObject({
      allow: true,
      rule: "messaging.reply",
    })
    expect(decide({ kind: "session", session: brain }, "session.message.interrupt", res, ctx).allow).toBe(false)
  })
})
