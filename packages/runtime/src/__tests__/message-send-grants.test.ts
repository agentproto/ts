/**
 * `message_send` / `message_reply` with explicit `defaults.messaging.grants`:
 * a pair the tree and the switches refuse becomes allowed (relation
 * `granted`), the delivered envelope carries `from.relation === "granted"`,
 * and with no grants the previous refusal stands.
 */

import { describe, it, expect, vi } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"
import type { Grant } from "@agentproto/policy"

import { registerMessageTools } from "../message-tools.js"
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

function spawnNode(
  registry: SessionsRegistry,
  workspaceSlug: string,
  label?: string,
): SessionDescriptor {
  return registry.spawnAgent({
    workspaceSlug,
    cwd: "/tmp",
    agentSession: fakeAgentSession(),
    adapterSlug: "mock",
    ...(label ? { label } : {}),
    depth: 0,
  })
}

async function harness(opts: {
  registry: SessionsRegistry
  callerSessionId: string
  messagingGrants?: readonly Grant[]
}) {
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  registerMessageTools(server, {
    registry: opts.registry,
    callerSessionId: opts.callerSessionId,
    allowSameWorkspace: false,
    ...(opts.messagingGrants ? { messagingGrants: opts.messagingGrants } : {}),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)
  return {
    client,
    close: async () => client.close(),
  }
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]!.text
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true
}

const grantTo = (sessionId: string): Grant => ({
  principal: "*",
  effect: "allow",
  actions: [{ action: "session:message", scope: sessionId }],
})

describe("message_send / message_reply - explicit grants", () => {
  it("admits a refused cross-workspace pair and delivers relation granted", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const brain = spawnNode(registry, "app-agentik-pygmalion", "pygmalion-brain-persistent")
    const pm = spawnNode(registry, "agentik-studio", "pm-simone")
    vi.spyOn(registry, "enqueuePrompt").mockResolvedValue({ queued: false })
    const send = vi.spyOn(registry, "sendMessage")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const h = await harness({
      registry,
      callerSessionId: brain.id,
      messagingGrants: [grantTo(pm.id), grantTo(brain.id)],
    })
    try {
      const result = await h.client.callTool({
        name: "message_send",
        arguments: { to: pm.id, text: "the launch copy is ready" },
      })
      expect(isError(result)).toBeFalsy()
      expect(JSON.parse(textOf(result))).toMatchObject({ ok: true, relation: "granted", to: pm.id })
      expect(send.mock.calls[0]![0].from).toMatchObject({ relation: "granted" })
      // A grant-admitted pair has no peer link, so it is never reported as an
      // unverified peer.
      expect(warn.mock.calls.map(c => c.join(" ")).join("\n")).not.toContain("peer-unverified")

      // The recipient replies; the reverse direction is admitted by the
      // matching grant naming the brain.
      const pmClient = await harness({
        registry,
        callerSessionId: pm.id,
        messagingGrants: [grantTo(pm.id), grantTo(brain.id)],
      })
      try {
        const reply = await pmClient.client.callTool({
          name: "message_reply",
          arguments: { replyTo: JSON.parse(textOf(result)).messageId, text: "ack" },
        })
        expect(isError(reply)).toBeFalsy()
        expect(JSON.parse(textOf(reply))).toMatchObject({ ok: true, relation: "granted", to: brain.id })
      } finally {
        await pmClient.close()
      }
    } finally {
      warn.mockRestore()
      await h.close()
    }
  })

  it("keeps the previous refusal when no grant matches", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const brain = spawnNode(registry, "app-agentik-pygmalion", "pygmalion-brain-persistent")
    const pm = spawnNode(registry, "agentik-studio", "pm-simone")
    const enqueue = vi.spyOn(registry, "enqueuePrompt").mockResolvedValue({ queued: false })
    const h = await harness({
      registry,
      callerSessionId: brain.id,
      messagingGrants: [grantTo("some-other-session")],
    })
    try {
      const result = await h.client.callTool({
        name: "message_send",
        arguments: { to: pm.id, text: "hello" },
      })
      expect(isError(result)).toBe(true)
      expect(textOf(result)).toContain("forbidden_recipient")
      expect(enqueue).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it("admits by operator labels end to end: a session-label:// sender principal and a label: recipient scope", async () => {
    // The R12 shape: the brain may message pm-simone by name, nobody else
    // may, and nothing opens the reverse direction. This goes through the
    // shared context builder, which is what makes a sender's operator label
    // resolvable as a `session-label://` principal.
    const registry = createSessionsRegistry({ persist: false })
    const brain = spawnNode(registry, "app-agentik-pygmalion")
    const pm = spawnNode(registry, "agentik-studio")
    const stranger = spawnNode(registry, "another-workspace")
    registry.setOperatorLabel(brain.id, "pygmalion-brain-persistent")
    registry.setOperatorLabel(pm.id, "pm-simone")
    vi.spyOn(registry, "enqueuePrompt").mockResolvedValue({ queued: false })
    const grants: Grant[] = [
      {
        principal: "session-label://pygmalion-brain-persistent",
        effect: "allow",
        actions: [{ action: "session:message", scope: "label:pm-simone" }],
      },
    ]
    const asBrain = await harness({ registry, callerSessionId: brain.id, messagingGrants: grants })
    const asStranger = await harness({ registry, callerSessionId: stranger.id, messagingGrants: grants })
    const asPm = await harness({ registry, callerSessionId: pm.id, messagingGrants: grants })
    try {
      const allowed = await asBrain.client.callTool({
        name: "message_send",
        arguments: { to: pm.id, text: "blocker on the launch copy" },
      })
      expect(isError(allowed)).toBeFalsy()
      expect(JSON.parse(textOf(allowed))).toMatchObject({ ok: true, relation: "granted", to: pm.id })

      // A sender without that label does not match the principal.
      const refusedStranger = await asStranger.client.callTool({
        name: "message_send",
        arguments: { to: pm.id, text: "hello" },
      })
      expect(isError(refusedStranger)).toBe(true)
      expect(textOf(refusedStranger)).toContain("forbidden_recipient")

      // The grant is one-way: pm-simone cannot message the brain.
      const refusedReverse = await asPm.client.callTool({
        name: "message_send",
        arguments: { to: brain.id, text: "hello" },
      })
      expect(isError(refusedReverse)).toBe(true)
      expect(textOf(refusedReverse)).toContain("forbidden_recipient")
    } finally {
      await asBrain.close()
      await asStranger.close()
      await asPm.close()
    }
  })
})
