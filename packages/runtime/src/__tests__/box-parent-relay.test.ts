/**
 * PARENT RELAY — a session running INSIDE a box (E2B / computer) reporting
 * UP to a parent session that lives in the HOST daemon's registry.
 *
 * The design is `docs/lineage-handover.md`, section "Known gap - sessions
 * running INSIDE a box". The slice covered here:
 *
 *  1. HOST: the spawn config carries the relay info — the host mints a
 *     short-lived, single-session-scoped relay token and forwards a REMOTE
 *     parent into the box's own `agent_start` (the box row has no local
 *     `parentSessionId`).
 *  2. BOX: a box-side `message_parent` call is forwarded to the host's relay
 *     endpoint instead of failing with "no recorded parent".
 *  3. HOST: the relay endpoint resolves the recipient FROM THE TOKEN (never
 *     from the payload) and delivers it to the right parent, with the
 *     kind/urgency preserved, through the ordinary `sendMessage` path.
 *  4. NO RELAY: the current clear error is still what a caller sees.
 *
 * Everything is faked — no real box, no real HTTP.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

const hostStarts: Array<Record<string, unknown>> = []
vi.mock("@agentproto/sandbox", async importOriginal => {
  const actual = await importOriginal<typeof import("@agentproto/sandbox")>()
  const fakeHost: Record<string, unknown> = {
    sandboxId: "sbx_relay_test",
    start: async (args: Record<string, unknown>) => {
      hostStarts.push(args)
      return { id: "sess_box_orch", status: "idle", startedAt: "2026-01-01T00:00:00.000Z" }
    },
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
    stop: async () => {},
    close: async () => {},
  }
  return {
    ...actual,
    createSandboxAgentSessionHost: vi.fn(async () => fakeHost),
  }
})
vi.mock("../sandbox-agent-session-proxy.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../sandbox-agent-session-proxy.js")>()
  return {
    ...actual,
    createSandboxAgentSessionProxy:
      (() => ({ send: async () => ({}), cancel: async () => {}, close: async () => {} })) as unknown as typeof actual.createSandboxAgentSessionProxy,
  }
})

import { registerAgentTools } from "../agent-tools.js"
import { bootSandboxAgentSession } from "../session-spawn.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"
import {
  deliverParentRelayMessage,
  mintParentRelayGrant,
  PARENT_RELAY_PATH,
  PARENT_RELAY_TOKEN_HEADER,
  type ParentRelayRegistry,
} from "../parent-relay.js"
import { setDefaultSessionsBaseDir } from "../transcript-writer.js"

const handle = {
  provider: {
    async connect() {
      throw new Error("not expected")
    },
    async boot() {
      throw new Error("not expected")
    },
  },
  slug: "fake",
  name: "Fake",
  version: "test",
  description: "test double",
  requiresSetup: false,
  capabilities: { networkEgress: false, mounts: false, lifecyclePause: false, readOnly: false },
  async check() {
    return true
  },
} as unknown as Parameters<typeof bootSandboxAgentSession>[0]["resolveSandboxProvider"] extends (
  slug: string,
) => infer R
  ? Awaited<R>
  : never

function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: "acp_relay_test",
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
  opts: { parentSessionId?: string; remoteParent?: { sessionId: string; url: string; token: string } } = {},
): string {
  const desc = registry.spawnAgent({
    workspaceSlug: "w",
    cwd: "/tmp",
    agentSession: fakeAgentSession(),
    adapterSlug: "mock",
    ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
    ...(opts.remoteParent ? { remoteParent: opts.remoteParent } : {}),
    depth: opts.parentSessionId ? 1 : 0,
  })
  return desc.id
}

async function harness(opts: { registry: SessionsRegistry; callerSessionId?: string }) {
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  registerAgentTools(server, {
    registry: opts.registry,
    ...(opts.callerSessionId ? { callerSessionId: opts.callerSessionId } : {}),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)
  return { client, close: async () => client.close() }
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]!.text
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true
}

describe("parent relay — the spawn config carries the relay info", () => {
  let base: string
  const savedEnv = process.env.AGENTPROTO_PARENT_RELAY_URL

  beforeEach(() => {
    hostStarts.length = 0
    base = join(mkdtempSync(join(tmpdir(), "parent-relay-")), "sessions")
    setDefaultSessionsBaseDir(base)
    process.env.AGENTPROTO_PARENT_RELAY_URL = "https://host.example"
    return () => setDefaultSessionsBaseDir(undefined)
  })

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.AGENTPROTO_PARENT_RELAY_URL
    else process.env.AGENTPROTO_PARENT_RELAY_URL = savedEnv
  })

  it("forwards a remote parent (parent id + relay url + token) into the box's own agent_start", async () => {
    const booted = await bootSandboxAgentSession({
      sandbox: "fake",
      adapter: "fake-cli",
      cwd: "/tmp",
      explicitCwd: true,
      parentRelay: { parentSessionId: "sess_parent", boxSessionId: "sess_box" },
      resolveSandboxProvider: vi.fn(async () => handle),
    })
    expect(booted.ok).toBe(true)
    expect(hostStarts).toHaveLength(1)
    const remoteParent = hostStarts[0]?.remoteParent as
      | { sessionId: string; url: string; token: string }
      | undefined
    expect(remoteParent?.sessionId).toBe("sess_parent")
    expect(remoteParent?.url).toBe("https://host.example")
    expect(remoteParent?.token).toEqual(expect.any(String))
    expect(remoteParent?.token.length).toBeGreaterThan(8)
  })

  it("no relay url configured → nothing is forwarded (the box keeps today's clear error)", async () => {
    delete process.env.AGENTPROTO_PARENT_RELAY_URL
    const booted = await bootSandboxAgentSession({
      sandbox: "fake",
      adapter: "fake-cli",
      cwd: "/tmp",
      explicitCwd: true,
      parentRelay: { parentSessionId: "sess_parent", boxSessionId: "sess_box" },
      resolveSandboxProvider: vi.fn(async () => handle),
    })
    expect(booted.ok).toBe(true)
    expect(hostStarts).toHaveLength(1)
    expect(hostStarts[0]?.remoteParent).toBeUndefined()
  })
})

describe("parent relay — the box forwards its report", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("a box-side message_parent is POSTed to the host's relay endpoint", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const boxSessionId = spawnNode(registry, {
      remoteParent: {
        sessionId: "sess_parent",
        url: "https://host.example",
        token: "tok_relay_123",
      },
    })
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        messageId: "msg_abcdef12",
        delivery: "enqueued",
        urgencyApplied: "next-turn",
      }),
    }))
    vi.stubGlobal("fetch", fetchMock)

    const h = await harness({ registry, callerSessionId: boxSessionId })
    try {
      const result = await h.client.callTool({
        name: "message_parent",
        arguments: { message: "done: 3 files patched", kind: "done" },
      })
      expect(isError(result)).toBeFalsy()
      const body = JSON.parse(textOf(result))
      expect(body.ok).toBe(true)
      expect(body.relayed).toBe(true)
      expect(body.parentSessionId).toBe("sess_parent")

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe(`https://host.example${PARENT_RELAY_PATH}`)
      const headers = init.headers as Record<string, string>
      expect(headers[PARENT_RELAY_TOKEN_HEADER]).toBe("tok_relay_123")
      expect(JSON.parse(String(init.body))).toEqual({
        message: "done: 3 files patched",
        kind: "done",
        urgency: "next-turn",
      })
    } finally {
      await h.close()
    }
  })

  it("a relay that refuses → the box reports the failure instead of pretending it was delivered", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const boxSessionId = spawnNode(registry, {
      remoteParent: {
        sessionId: "sess_parent",
        url: "https://host.example",
        token: "tok_relay_123",
      },
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ ok: false, error: "relay_token_unknown", message: "nope" }),
      })),
    )
    const h = await harness({ registry, callerSessionId: boxSessionId })
    try {
      const result = await h.client.callTool({
        name: "message_parent",
        arguments: { message: "half done" },
      })
      expect(isError(result)).toBe(true)
      expect(textOf(result)).toContain("could not relay")
    } finally {
      await h.close()
    }
  })
})

describe("parent relay — the host delivers to the right parent", () => {
  it("resolves the recipient from the token (never the payload) and preserves kind/urgency", async () => {
    const sent: Array<{ to: string; from?: { sessionId?: string; relation?: string }; kind: string; urgency: string; text: string }> = []
    const fakeRegistry: ParentRelayRegistry = {
      get: (id: string) =>
        id === "sess_parent"
          ? { id: "sess_parent", status: "running" }
          : id === "sess_box"
            ? { id: "sess_box", status: "running", parentSessionId: "sess_parent" }
            : undefined,
      sendMessage: async envelope => {
        sent.push(envelope)
        return { messageId: envelope.id, queued: false, urgencyApplied: envelope.urgency }
      },
    }
    const remote = mintParentRelayGrant({
      parentSessionId: "sess_parent",
      boxSessionId: "sess_box",
      url: "https://host.example",
    })
    const result = await deliverParentRelayMessage({
      token: remote.token,
      payload: { message: "blocked on a flaky test", kind: "blocker", urgency: "steer" },
      registry: fakeRegistry,
    })
    expect(result.ok).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toBe("sess_parent")
    expect(sent[0]?.from?.sessionId).toBe("sess_box")
    expect(sent[0]?.from?.relation).toBe("child")
    expect(sent[0]?.kind).toBe("blocker")
    expect(sent[0]?.urgency).toBe("steer")
    expect(sent[0]?.text).toBe("blocked on a flaky test")
  })

  it("an unknown/expired token is refused — the payload cannot pick the recipient", async () => {
    const fakeRegistry: ParentRelayRegistry = {
      get: () => undefined,
      sendMessage: async () => {
        throw new Error("must not be called")
      },
    }
    const result = await deliverParentRelayMessage({
      token: "not-a-real-token",
      payload: { message: "hi", kind: "report", urgency: "next-turn" },
      registry: fakeRegistry,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected a refusal")
    expect(result.code).toBe("relay_token_unknown")
  })

  it("the host-side delivery reaches the parent as a normal session-message envelope", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const parentId = spawnNode(registry)
    const boxId = spawnNode(registry, { parentSessionId: parentId })
    const enqueue = vi.spyOn(registry, "enqueuePrompt").mockResolvedValue({ queued: false })
    const remote = mintParentRelayGrant({
      parentSessionId: parentId,
      boxSessionId: boxId,
      url: "https://host.example",
    })
    const result = await deliverParentRelayMessage({
      token: remote.token,
      payload: { message: "report from the box", kind: "report", urgency: "next-turn" },
      registry,
    })
    expect(result.ok).toBe(true)
    expect(enqueue).toHaveBeenCalledTimes(1)
    const [recipient, text, opts] = enqueue.mock.calls[0] as unknown as [
      string,
      string,
      { envelope?: { to: string; from: { sessionId?: string; relation?: string }; kind: string; urgency: string }; source?: string },
    ]
    expect(recipient).toBe(parentId)
    expect(text).toBe("report from the box")
    expect(opts.envelope?.to).toBe(parentId)
    expect(opts.envelope?.from.sessionId).toBe(boxId)
    expect(opts.envelope?.from.relation).toBe("child")
    expect(opts.envelope?.kind).toBe("report")
    expect(opts.envelope?.urgency).toBe("next-turn")
    expect(opts.source).toBe(`child:${boxId}`)
  })
})

describe("parent relay — no relay configured keeps today's error", () => {
  it("a box session with no remote parent still gets the clear 'no recorded parent' error", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const boxSessionId = spawnNode(registry)
    const h = await harness({ registry, callerSessionId: boxSessionId })
    try {
      const result = await h.client.callTool({
        name: "message_parent",
        arguments: { message: "anyone there?" },
      })
      expect(isError(result)).toBe(true)
      expect(textOf(result)).toContain("no recorded parent")
    } finally {
      await h.close()
    }
  })
})
