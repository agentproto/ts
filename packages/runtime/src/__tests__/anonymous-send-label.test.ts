/**
 * `defaults.messaging.anonymousSend`: `message_send` from an anonymous or
 * unverified sender (an identity-less MCP client, or the shared
 * `claude-desktop` Chat-tab identity) to an unrelated live session.
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
import { decide, type PermissionResource } from "../permissions.js"
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

function world() {
  const registry = createSessionsRegistry({ persist: false })
  const pm = spawnNode(registry, "agentik-studio", "pm-pygmalion")
  vi.spyOn(registry, "enqueuePrompt").mockResolvedValue({ queued: false })
  const send = vi.spyOn(registry, "sendMessage")
  // The shared Claude Desktop Chat-tab identity, claimed (unverified).
  registry.touchExternal({ id: "claude-desktop", host: "claude-desktop" })
  return { registry, pm, send }
}

describe("anonymousSend - claude-desktop shared identity (unverified session sender)", () => {
  it("label: delivers to an unrelated live session, prefixed and capped at steer", async () => {
    const { registry, pm, send } = world()
    const h = await harness({ registry, callerSessionId: "claude-desktop", anonymousSend: "label", allowInterrupt: true })
    try {
      const result = await h.client.callTool({
        name: "message_send",
        arguments: { to: pm.id, text: "ping from chat", urgency: "interrupt" },
      })
      expect(isError(result)).toBeFalsy()
      expect(JSON.parse(textOf(result))).toMatchObject({
        ok: true,
        to: pm.id,
        unverified: true,
        urgencyApplied: "steer",
      })
      const msg = send.mock.calls[0]![0]
      expect(msg.text).toBe("[unverified sender: claude-desktop] ping from chat")
      expect(msg.from).toMatchObject({ sessionId: "claude-desktop", unverified: true })
    } finally {
      await h.close()
    }
  })

  it("block: refuses with forbidden_recipient, as before", async () => {
    const { registry, pm, send } = world()
    const h = await harness({ registry, callerSessionId: "claude-desktop", anonymousSend: "block" })
    try {
      const result = await h.client.callTool({ name: "message_send", arguments: { to: pm.id, text: "x" } })
      expect(isError(result)).toBe(true)
      expect(JSON.parse(textOf(result)).error).toBe("forbidden_recipient")
      expect(send).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it("agent_prompt stays refused for the unverified sender whatever the knob says", () => {
    const { registry, pm } = world()
    const sender = registry.get("claude-desktop")!
    const res: PermissionResource = {
      kind: "session",
      session: pm,
      drive: { tool: "agent_prompt", action: "session:prompt" },
    }
    for (const anonymousSend of ["label", "block"] as const) {
      const d = decide({ kind: "session", session: sender }, "session.drive", res, {
        messaging: { anonymousSend },
        parentOf: id => registry.get(id)?.parentSessionId,
      })
      expect(d.allow).toBe(false)
    }
  })
})

describe("anonymousSend - verified sender", () => {
  it("an unrelated verified session is still refused under label", async () => {
    const { registry, pm, send } = world()
    const other = spawnNode(registry, "other-workspace", "other")
    const h = await harness({ registry, callerSessionId: other.id, anonymousSend: "label" })
    try {
      const result = await h.client.callTool({ name: "message_send", arguments: { to: pm.id, text: "x" } })
      expect(isError(result)).toBe(true)
      expect(JSON.parse(textOf(result)).error).toBe("forbidden_recipient")
      expect(send).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })
})

describe("anonymousSend - identity-less caller (mcp.noCallerIdentity accept)", () => {
  it("label: delivers prefixed with the anonymous label, interrupt degrades to steer", async () => {
    const { registry, pm, send } = world()
    const h = await harness({ registry, noCallerIdentity: "accept", anonymousSend: "label", allowInterrupt: true })
    try {
      const result = await h.client.callTool({
        name: "message_send",
        arguments: { to: pm.id, text: "hello", urgency: "interrupt" },
      })
      expect(isError(result)).toBeFalsy()
      expect(JSON.parse(textOf(result))).toMatchObject({
        ok: true,
        anonymous: true,
        unverified: true,
        urgencyApplied: "steer",
      })
      const msg = send.mock.calls[0]![0]
      expect(msg.text).toBe("[unverified sender: claude-code] hello")
      expect(msg.from).toMatchObject({ anonymous: true })
    } finally {
      await h.close()
    }
  })

  it("block: anonymous delivery is unchanged (no prefix, accept still governs admission)", async () => {
    const { registry, pm, send } = world()
    const h = await harness({ registry, noCallerIdentity: "accept", anonymousSend: "block" })
    try {
      const result = await h.client.callTool({ name: "message_send", arguments: { to: pm.id, text: "hello" } })
      expect(isError(result)).toBeFalsy()
      expect(send.mock.calls[0]![0].text).toBe("hello")
    } finally {
      await h.close()
    }
  })
})
