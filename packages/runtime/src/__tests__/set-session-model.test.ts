/**
 * `SessionsRegistry.setModel` — mid-session model switch on a LIVE
 * agent-cli session, without restarting it. Covers the registry method,
 * `POST /sessions/:id/model`, and the MCP `agent_set_model` mirror.
 *
 * Every assertion here fails on `main`: the registry has no `setModel`
 * method, the HTTP route 404s (no handler matches `/sessions/:id/model`),
 * and the MCP tool doesn't exist.
 */

import { describe, it, expect } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { startHttpServer } from "../http-server.js"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { createSessionEventBus, type SessionEvent } from "../session-event-bus.js"
import { registerAgentTools } from "../agent-tools.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

function noopConversations(): ConversationStore {
  return {
    async open() {},
    async appendTurn() {},
    async read() {
      return { meta: {} as never, turns: [] }
    },
    async list() {
      return []
    },
    pathFor: (id: string) => id,
  }
}

function noopHeartbeat(): HeartbeatRunner {
  return { start() {}, stop() {}, async fireNow() {} }
}

async function mcpServerFactory() {
  return (await createMcpServer({ specs: [], name: "main", version: "0" })).server
}

/** An agent session whose driver supports live model switching — the ACP
 *  "config" strategy shape (always succeeds, echoing the requested id). */
function switchableAgentSession(): AgentSessionLike {
  return {
    sessionId: "switchable-session",
    async *send() {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
    async setModel(modelId: string) {
      return { applied: true, model: modelId }
    },
  }
}

/** A driver whose adapter rejects the switch — e.g. an unknown/gated model
 *  id, or a "command" strategy that never saw an acknowledgement. */
function rejectingAgentSession(): AgentSessionLike {
  return {
    sessionId: "rejecting-session",
    async *send() {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
    async setModel() {
      return { applied: false, reason: "requires-restart" }
    },
  }
}

/** A driver session that predates `setModel` entirely (no such method) —
 *  the registry must degrade to `{applied:false, reason:"not-supported"}`
 *  rather than throwing a "not a function" error. */
function legacyAgentSession(): AgentSessionLike {
  return {
    sessionId: "legacy-session",
    async *send() {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

/** A driver session that records the exact model id passed to `setModel`,
 *  so tests can assert what the adapter's wire receives after registry-level
 *  normalization. */
function recordingAgentSession(): AgentSessionLike & { lastSetModel?: string } {
  const session: AgentSessionLike & { lastSetModel?: string } = {
    sessionId: "recording-session",
    async *send() {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
    async setModel(modelId: string) {
      session.lastSetModel = modelId
      return { applied: true, model: modelId }
    },
  }
  return session
}

describe("SessionsRegistry.setModel", () => {
  it("applies the switch, updates the descriptor's model, and emits session:model-changed", async () => {
    const bus = createSessionEventBus()
    const seen: SessionEvent[] = []
    bus.onAny(ev => seen.push(ev))

    const reg = createSessionsRegistry({ persist: false, sessionEvents: bus })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: switchableAgentSession(),
      adapterSlug: "fake",
      label: "my-conversation",
    })

    const result = await reg.setModel(desc.id, "claude-sonnet-5")
    expect(result).toEqual({ applied: true, model: "claude-sonnet-5" })
    expect(reg.get(desc.id)?.model).toBe("claude-sonnet-5")
    // A switch made through this daemon means requested and active agree —
    // see SessionDescriptor.activeModel's doc.
    expect(reg.get(desc.id)?.activeModel).toBe("claude-sonnet-5")

    const modelChanged = seen.find(ev => ev.type === "session:model-changed")
    expect(modelChanged).toEqual({
      type: "session:model-changed",
      sessionId: desc.id,
      model: "claude-sonnet-5",
      activeModel: "claude-sonnet-5",
      label: "my-conversation",
      ts: expect.any(String),
    })

    // The axis-generic successor event (SPEC step 4) fires alongside the
    // back-compat alias, carrying WHICH axis moved + the new value.
    const configChanged = seen.find(ev => ev.type === "session:config-changed")
    expect(configChanged).toEqual({
      type: "session:config-changed",
      sessionId: desc.id,
      axis: "model",
      value: "claude-sonnet-5",
      label: "my-conversation",
      ts: expect.any(String),
    })
    reg.shutdown()
  })

  it("does not touch the descriptor or emit an event when the switch is rejected", async () => {
    const bus = createSessionEventBus()
    const seen: SessionEvent[] = []
    bus.onAny(ev => seen.push(ev))

    const reg = createSessionsRegistry({ persist: false, sessionEvents: bus })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: rejectingAgentSession(),
      adapterSlug: "fake",
      model: "original-model",
    })

    const result = await reg.setModel(desc.id, "o4-mini")
    expect(result).toEqual({ applied: false, reason: "requires-restart" })
    // The original model is untouched — a rejected switch changes nothing.
    expect(reg.get(desc.id)?.model).toBe("original-model")
    expect(seen.find(ev => ev.type === "session:model-changed")).toBeUndefined()
    // A rejected switch changes nothing, so neither event fires.
    expect(seen.find(ev => ev.type === "session:config-changed")).toBeUndefined()
    reg.shutdown()
  })

  it("reports not-supported for a driver session with no setModel method, rather than throwing", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: legacyAgentSession(),
      adapterSlug: "fake",
    })

    await expect(reg.setModel(desc.id, "claude-sonnet-5")).resolves.toEqual({
      applied: false,
      reason: "not-supported",
    })
    reg.shutdown()
  })

  it("throws for an unknown session id", async () => {
    const reg = createSessionsRegistry({ persist: false })
    await expect(reg.setModel("nope", "x")).rejects.toThrow(/no session "nope"/)
    reg.shutdown()
  })

  it("throws for a non-agent-cli session (kind: command)", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.recordCommand({
      workspaceSlug: "default",
      cwd: "/tmp",
      command: "echo hi",
      args: ["echo", "hi"],
      exitCode: 0,
      signal: null,
      durationMs: 5,
      stdout: "hi\n",
      stderr: "",
    })
    await expect(reg.setModel(desc.id, "x")).rejects.toThrow(/not an agent-cli session/)
    reg.shutdown()
  })

  it("strips only @openrouter for derived-from-model adapters (Hermes / Kimi)", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const session = recordingAgentSession()
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: session,
      adapterSlug: "hermes",
      routeSelection: "derived-from-model",
      model: "moonshotai/kimi-k2.7-code@openrouter",
    })

    await expect(
      reg.setModel(desc.id, "moonshotai/kimi-k2.7-code@openrouter"),
    ).resolves.toEqual({
      applied: true,
      model: "moonshotai/kimi-k2.7-code@openrouter",
    })
    expect(session.lastSetModel).toBe("moonshotai/kimi-k2.7-code")
    expect(reg.get(desc.id)?.model).toBe("moonshotai/kimi-k2.7-code@openrouter")
    reg.shutdown()
  })

  it("strips only @openrouter for derived-from-model adapters (Hermes / DeepSeek)", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const session = recordingAgentSession()
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: session,
      adapterSlug: "hermes",
      routeSelection: "derived-from-model",
      model: "deepseek/deepseek-chat@openrouter",
    })

    await expect(
      reg.setModel(desc.id, "deepseek/deepseek-v4-pro@openrouter"),
    ).resolves.toEqual({
      applied: true,
      model: "deepseek/deepseek-v4-pro@openrouter",
    })
    expect(session.lastSetModel).toBe("deepseek/deepseek-v4-pro")
    expect(reg.get(desc.id)?.model).toBe("deepseek/deepseek-v4-pro@openrouter")
    reg.shutdown()
  })

  it("bares direct vendor/product refs for fixed native adapters (claude-code / anthropic)", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const session = recordingAgentSession()
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: session,
      adapterSlug: "claude-code",
      adapterProvider: "anthropic",
      model: "anthropic/claude-sonnet-5",
    })

    await expect(
      reg.setModel(desc.id, "anthropic/claude-opus-4-8"),
    ).resolves.toEqual({
      applied: true,
      model: "anthropic/claude-opus-4-8",
    })
    expect(session.lastSetModel).toBe("claude-opus-4-8")
    expect(reg.get(desc.id)?.model).toBe("anthropic/claude-opus-4-8")
    reg.shutdown()
  })

  it("keeps vendor/product on a non-native gateway while stripping the route suffix", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const session = recordingAgentSession()
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: session,
      adapterSlug: "claude-code",
      routeSelection: "free",
      adapterProvider: "anthropic",
      route: { gateway: "openrouter" },
      model: "moonshotai/kimi-k2.7-code@openrouter",
    })

    await expect(
      reg.setModel(desc.id, "deepseek/deepseek-v4-pro@openrouter"),
    ).resolves.toEqual({
      applied: true,
      model: "deepseek/deepseek-v4-pro@openrouter",
    })
    expect(session.lastSetModel).toBe("deepseek/deepseek-v4-pro")
    expect(reg.get(desc.id)?.model).toBe("deepseek/deepseek-v4-pro@openrouter")
    reg.shutdown()
  })

  it("hydrates adapter metadata before switching a pre-normalization descriptor", async () => {
    const session = recordingAgentSession()
    const reg = createSessionsRegistry({
      persist: false,
      resolveAgentAdapter: async () => ({
        startSession: async () => recordingAgentSession(),
        commandPreview: "claude-code",
        routeSelection: "free",
        authDescriptor: { provider: "anthropic" },
      }),
    })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: session,
      adapterSlug: "claude-code",
      model: "anthropic/claude-sonnet-5",
    })

    await reg.setModel(desc.id, "anthropic/claude-opus-4-8")
    expect(session.lastSetModel).toBe("claude-opus-4-8")
    expect(reg.get(desc.id)).toMatchObject({
      model: "anthropic/claude-opus-4-8",
      routeSelection: "free",
      adapterProvider: "anthropic",
    })
    reg.shutdown()
  })

  it("keeps the cross-route guard and does not call setModel across routes", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const session = recordingAgentSession()
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: session,
      adapterSlug: "claude-code",
      adapterProvider: "anthropic",
      model: "anthropic/claude-sonnet-5",
    })

    const result = await reg.setModel(desc.id, "deepseek/deepseek-v4-pro@openrouter")
    expect(result).toEqual({
      applied: false,
      reason: "requires-restart",
      suggestedOverride: {
        route: { gateway: "openrouter" },
        model: "deepseek/deepseek-v4-pro@openrouter",
      },
    })
    expect(session.lastSetModel).toBeUndefined()
    reg.shutdown()
  })

  it("recognizes router-prefixed target ids in the cross-route guard", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const session = recordingAgentSession()
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: session,
      adapterSlug: "claude-code",
      adapterProvider: "anthropic",
      model: "anthropic/claude-sonnet-5",
    })

    await expect(
      reg.setModel(desc.id, "openrouter/deepseek/deepseek-v4-pro"),
    ).resolves.toEqual({
      applied: false,
      reason: "requires-restart",
      suggestedOverride: {
        route: { gateway: "openrouter" },
        model: "openrouter/deepseek/deepseek-v4-pro",
      },
    })
    expect(session.lastSetModel).toBeUndefined()
    reg.shutdown()
  })
})

describe("POST /sessions/:id/model — HTTP route", () => {
  it("200 with the structured result on both applied and rejected switches; 404 unknown; 400 missing model", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: registry,
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const ok = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: switchableAgentSession(),
        adapterSlug: "fake",
      })
      const okRes = await fetch(`http://127.0.0.1:${port}/sessions/${ok.id}/model`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "opus-5" }),
      })
      expect(okRes.status).toBe(200)
      expect(await okRes.json()).toEqual({
        ok: true,
        id: ok.id,
        applied: true,
        model: "opus-5",
      })

      const rejected = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: rejectingAgentSession(),
        adapterSlug: "fake",
      })
      const rejectedRes = await fetch(
        `http://127.0.0.1:${port}/sessions/${rejected.id}/model`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "o4-mini" }),
        },
      )
      expect(rejectedRes.status).toBe(200)
      expect(await rejectedRes.json()).toEqual({
        ok: true,
        id: rejected.id,
        applied: false,
        reason: "requires-restart",
      })

      const missingModelRes = await fetch(
        `http://127.0.0.1:${port}/sessions/${ok.id}/model`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      )
      expect(missingModelRes.status).toBe(400)

      const unknownRes = await fetch(`http://127.0.0.1:${port}/sessions/nope/model`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "x" }),
      })
      expect(unknownRes.status).toBe(404)
    } finally {
      await http.stop()
    }
  })

  it("auth gate parity with POST /sessions/:id/prompt", async () => {
    const TOKEN = "test-secret-token"
    const registry = createSessionsRegistry({ persist: false })
    const port = await freePort()
    const http = await startHttpServer({
      port,
      token: TOKEN,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: registry,
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const noAuth = await fetch(`http://127.0.0.1:${port}/sessions/nope/model`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "x" }),
      })
      expect(noAuth.status).toBe(401)

      const withToken = await fetch(`http://127.0.0.1:${port}/sessions/nope/model`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ model: "x" }),
      })
      // Past the auth gate — the (nonexistent) session then 404s.
      expect(withToken.status).toBe(404)
    } finally {
      await http.stop()
    }
  })
})

describe("agent_set_model (MCP)", () => {
  it("switches the model on a live session", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: switchableAgentSession(),
      adapterSlug: "fake",
    })

    const server = new McpServer({ name: "agent-set-model-server", version: "0.0.0" })
    registerAgentTools(server, { registry })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "agent-set-model-client", version: "0.0.0" })
    await client.connect(clientTransport)

    const result = (await client.callTool({
      name: "agent_set_model",
      arguments: { sessionId: desc.id, model: "opus-5" },
    })) as { isError?: boolean; content: Array<{ type: "text"; text: string }> }
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      ok: true,
      sessionId: desc.id,
      applied: true,
      model: "opus-5",
    })
    expect(registry.get(desc.id)?.model).toBe("opus-5")
    registry.shutdown()
  })

  it("errors with missingSessionIdError when no session id is given", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const server = new McpServer({ name: "agent-set-model-server-2", version: "0.0.0" })
    registerAgentTools(server, { registry })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "agent-set-model-client-2", version: "0.0.0" })
    await client.connect(clientTransport)

    const result = (await client.callTool({
      name: "agent_set_model",
      arguments: { model: "x" },
    })) as { isError?: boolean }
    expect(result.isError).toBe(true)
    registry.shutdown()
  })
})
