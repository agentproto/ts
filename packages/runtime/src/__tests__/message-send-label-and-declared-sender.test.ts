/**
 * `message_send` addressing and sender declaration:
 *
 *  - `to: "label:<label>"` resolves to the single LIVE session carrying that
 *    operator-assigned label (a killed twin with the same label never matches);
 *    zero live matches is `no_live_session_for_label`, several is
 *    `ambiguous_label`. The permission check runs on the RESOLVED session, so a
 *    label never widens who can be reached.
 *  - `declaredSender: "cc:<id>"` is accepted only from the shared unverified
 *    `claude-desktop` identity: the recipient sees a declared, unverified
 *    sender, urgency stays capped, permissions still use the real caller.
 */

import { describe, it, expect, vi } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerMessageTools } from "../message-tools.js"
import { renderSessionMessage, renderInboxDigest } from "../session-message.js"
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
  operatorLabel?: string,
  label?: string,
): SessionDescriptor {
  const d = registry.spawnAgent({
    workspaceSlug,
    cwd: "/tmp",
    agentSession: fakeAgentSession(),
    adapterSlug: "mock",
    ...(label ? { label } : {}),
    depth: 0,
  })
  if (operatorLabel) registry.setOperatorLabel(d.id, operatorLabel)
  return d
}

async function harness(opts: {
  registry: SessionsRegistry
  callerSessionId?: string
  allowSameWorkspace?: boolean
  anonymousSend?: "block" | "label"
  noCallerIdentity?: "accept"
  allowInterrupt?: boolean
}) {
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  registerMessageTools(server, {
    registry: opts.registry,
    ...(opts.callerSessionId ? { callerSessionId: opts.callerSessionId } : {}),
    allowSameWorkspace: opts.allowSameWorkspace ?? true,
    ...(opts.anonymousSend ? { anonymousSend: opts.anonymousSend } : {}),
    ...(opts.noCallerIdentity ? { noCallerIdentity: opts.noCallerIdentity } : {}),
    ...(opts.allowInterrupt ? { allowInterrupt: true } : {}),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)
  const call = async (args: Record<string, unknown>) => {
    const r = await client.callTool({ name: "message_send", arguments: args })
    const text = (r as { content: Array<{ text: string }> }).content[0]!.text
    return { isError: (r as { isError?: boolean }).isError === true, body: JSON.parse(text) as Record<string, any> }
  }
  return { client, call, close: async () => client.close() }
}

const LABEL = "pygmalion-brain-persistent"

function world() {
  const registry = createSessionsRegistry({ persist: false })
  vi.spyOn(registry, "enqueuePrompt").mockResolvedValue({ queued: false })
  const send = vi.spyOn(registry, "sendMessage")
  return { registry, send }
}

describe("message_send to: label:<label>", () => {
  it("resolves to the live session and not to a killed twin with the same label", async () => {
    const { registry, send } = world()
    const caller = spawnNode(registry, "ws-a")
    const retired = spawnNode(registry, "ws-a", LABEL)
    const live = spawnNode(registry, "ws-a", LABEL)
    registry.kill(retired.id)
    const h = await harness({ registry, callerSessionId: caller.id })
    try {
      const r = await h.call({ to: `label:${LABEL}`, text: "hello brain" })
      expect(r.isError).toBe(false)
      expect(r.body).toMatchObject({ ok: true, to: live.id })
      expect(send.mock.calls.map(c => c[0].to)).toEqual([live.id])
    } finally {
      await h.close()
    }
  })

  it("no live session for the label is a typed error and sends nothing", async () => {
    const { registry, send } = world()
    const caller = spawnNode(registry, "ws-a")
    const dead = spawnNode(registry, "ws-a", LABEL)
    registry.kill(dead.id)
    const h = await harness({ registry, callerSessionId: caller.id })
    try {
      for (const label of [LABEL, "never-used"]) {
        const r = await h.call({ to: `label:${label}`, text: "x" })
        expect(r.isError).toBe(true)
        expect(r.body.error).toBe("no_live_session_for_label")
      }
      expect(send).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it("several live sessions with the label is ambiguous_label, listing ids, picking none", async () => {
    const { registry, send } = world()
    const caller = spawnNode(registry, "ws-a")
    const a = spawnNode(registry, "ws-a", LABEL)
    const b = spawnNode(registry, "ws-a", LABEL)
    const h = await harness({ registry, callerSessionId: caller.id })
    try {
      const r = await h.call({ to: `label:${LABEL}`, text: "x" })
      expect(r.isError).toBe(true)
      expect(r.body.error).toBe("ambiguous_label")
      expect(r.body.message).toContain(a.id)
      expect(r.body.message).toContain(b.id)
      expect(send).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it("a label does not widen reach: a session outside the allowed set stays forbidden", async () => {
    const { registry, send } = world()
    const caller = spawnNode(registry, "ws-a")
    const outsider = spawnNode(registry, "ws-b", LABEL)
    const h = await harness({ registry, callerSessionId: caller.id, allowSameWorkspace: true })
    try {
      const byId = await h.call({ to: outsider.id, text: "x" })
      const byLabel = await h.call({ to: `label:${LABEL}`, text: "x" })
      expect(byId.body.error).toBe("forbidden_recipient")
      expect(byLabel.body.error).toBe("forbidden_recipient")
      expect(send).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it("an ambiguous error does not list sessions the caller may not message", async () => {
    const { registry } = world()
    const caller = spawnNode(registry, "ws-a")
    const mine = spawnNode(registry, "ws-a", LABEL)
    const hidden = spawnNode(registry, "ws-b", LABEL)
    const h = await harness({ registry, callerSessionId: caller.id })
    try {
      const r = await h.call({ to: `label:${LABEL}`, text: "x" })
      expect(r.body.error).toBe("ambiguous_label")
      expect(r.body.message).toContain(mine.id)
      expect(r.body.message).not.toContain(hidden.id)
      expect(r.body.message).toContain("1 more you may not message")
    } finally {
      await h.close()
    }
  })

  it("matches only the immutable operator label, never the mutable session label", async () => {
    const { registry, send } = world()
    const caller = spawnNode(registry, "ws-a")
    spawnNode(registry, "ws-a", undefined, LABEL)
    const h = await harness({ registry, callerSessionId: caller.id })
    try {
      const r = await h.call({ to: `label:${LABEL}`, text: "x" })
      expect(r.body.error).toBe("no_live_session_for_label")
      expect(send).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it("rejects an empty label", async () => {
    const { registry } = world()
    const caller = spawnNode(registry, "ws-a")
    const h = await harness({ registry, callerSessionId: caller.id })
    try {
      expect((await h.call({ to: "label:", text: "x" })).body.error).toBe("invalid_label")
    } finally {
      await h.close()
    }
  })

  it("resolves for an identity-less caller let through by noCallerIdentity accept", async () => {
    const { registry, send } = world()
    const live = spawnNode(registry, "ws-a", LABEL)
    const h = await harness({ registry, noCallerIdentity: "accept" })
    try {
      const r = await h.call({ to: `label:${LABEL}`, text: "x" })
      expect(r.body).toMatchObject({ ok: true, to: live.id, anonymous: true })
      expect(send.mock.calls[0]![0].to).toBe(live.id)
    } finally {
      await h.close()
    }
  })
})

describe("message_send declaredSender", () => {
  const desktopWorld = () => {
    const w = world()
    const pm = spawnNode(w.registry, "agentik-studio")
    w.registry.touchExternal({ id: "claude-desktop", host: "claude-desktop" })
    return { ...w, pm }
  }

  it("shows a declared, unverified sender and a reply address, still capped at steer", async () => {
    const { registry, pm, send } = desktopWorld()
    const h = await harness({
      registry,
      callerSessionId: "claude-desktop",
      allowSameWorkspace: false,
      anonymousSend: "label",
      allowInterrupt: true,
    })
    try {
      const r = await h.call({ to: pm.id, text: "ping", urgency: "interrupt", declaredSender: "cc:abc-123" })
      expect(r.isError).toBe(false)
      expect(r.body).toMatchObject({ ok: true, to: pm.id, urgencyApplied: "steer", declaredSender: "cc:abc-123" })
      const msg = send.mock.calls[0]![0]
      expect(msg.text).toBe("[declared sender: cc:abc-123, unverified] ping")
      expect(msg.text).not.toContain("[unverified sender")
      expect(msg.from).toMatchObject({ sessionId: "claude-desktop", unverified: true, declaredSender: "cc:abc-123" })
      expect(msg.replyAddress).toBe("cc:abc-123")
      const rendered = renderSessionMessage(msg)
      expect(rendered).toContain('unverified="true"')
      expect(rendered).toContain('declared-sender="cc:abc-123"')
      expect(rendered).toContain("reply to: cc:abc-123")
    } finally {
      await h.close()
    }
  })

  it("never interrupts even when the shared row is admitted without the unverified cap", async () => {
    const { registry, pm, send } = desktopWorld()
    const h = await harness({ registry, callerSessionId: "claude-desktop", allowSameWorkspace: true, allowInterrupt: true })
    try {
      const r = await h.call({ to: pm.id, text: "ping", urgency: "interrupt", declaredSender: "cc:abc" })
      expect(r.isError).toBe(false)
      expect(r.body.urgencyApplied).not.toBe("interrupt")
      expect(send.mock.calls[0]![0].text.startsWith("[declared sender: cc:abc, unverified] ")).toBe(true)
    } finally {
      await h.close()
    }
  })

  it("without declaredSender the header is unchanged", async () => {
    const { registry, pm, send } = desktopWorld()
    const h = await harness({ registry, callerSessionId: "claude-desktop", allowSameWorkspace: false })
    try {
      const r = await h.call({ to: pm.id, text: "ping" })
      expect(r.isError).toBe(false)
      expect(r.body.declaredSender).toBeUndefined()
      const msg = send.mock.calls[0]![0]
      expect(msg.text).toBe("[unverified sender: claude-desktop] ping")
      expect(msg.from.declaredSender).toBeUndefined()
      expect(msg.replyAddress).toBeUndefined()
    } finally {
      await h.close()
    }
  })

  it("is refused for a call that carries a real session identity", async () => {
    const { registry, pm, send } = desktopWorld()
    const real = spawnNode(registry, "agentik-studio")
    const h = await harness({ registry, callerSessionId: real.id })
    try {
      const r = await h.call({ to: pm.id, text: "ping", declaredSender: "cc:abc" })
      expect(r.isError).toBe(true)
      expect(r.body.error).toBe("declared_sender_refused")
      expect(send).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it("is refused for an identity-less caller and for an attested cc: caller", async () => {
    const { registry, pm, send } = desktopWorld()
    registry.touchExternal({ id: "cc:attested", host: "claude-desktop" })
    const anon = await harness({ registry, noCallerIdentity: "accept" })
    const attested = await harness({ registry, callerSessionId: "cc:attested" })
    try {
      expect((await anon.call({ to: pm.id, text: "x", declaredSender: "cc:abc" })).body.error).toBe(
        "declared_sender_refused",
      )
      expect((await attested.call({ to: pm.id, text: "x", declaredSender: "cc:abc" })).body.error).toBe(
        "declared_sender_refused",
      )
      expect(send).not.toHaveBeenCalled()
    } finally {
      await anon.close()
      await attested.close()
    }
  })

  it("accepts only the cc:<session_id> form", async () => {
    const { registry, pm, send } = desktopWorld()
    const h = await harness({ registry, callerSessionId: "claude-desktop", allowSameWorkspace: false })
    try {
      for (const declaredSender of ["sess_other", "cc:", "cc:bad id!", "claude-desktop"]) {
        const r = await h.call({ to: pm.id, text: "x", declaredSender })
        expect(r.body.error, declaredSender).toBe("invalid_declared_sender")
      }
      expect(send).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it("does not widen reach: permissions still use the real (shared) caller", async () => {
    const { registry, pm, send } = desktopWorld()
    const h = await harness({
      registry,
      callerSessionId: "claude-desktop",
      allowSameWorkspace: false,
      anonymousSend: "block",
    })
    try {
      const r = await h.call({ to: pm.id, text: "x", declaredSender: "cc:abc" })
      expect(r.body.error).toBe("forbidden_recipient")
      expect(send).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it("renders the declared sender in the inbox digest as unverified", () => {
    const text = renderInboxDigest([
      {
        id: "msg_1",
        ts: "2026-11-09T00:00:00.000Z",
        to: "sess_x",
        kind: "report",
        urgency: "fyi",
        text: "t",
        from: { sessionId: "claude-desktop", relation: "granted", unverified: true, declaredSender: "cc:abc" },
      },
    ])
    expect(text).toContain("unverified, declared sender cc:abc")
  })
})
