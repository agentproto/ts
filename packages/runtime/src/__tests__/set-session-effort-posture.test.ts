/**
 * Live effort + live posture + the model↔route guard (SPEC §4.2/§4.4, build
 * step 5). Covers the registry methods `setEffort`/`setPosture`, their HTTP
 * routes (`POST /sessions/:id/{effort,posture}`), the MCP mirrors
 * (`agent_set_effort`/`agent_set_posture`), and the R2 cross-route guard baked
 * into `setModel`.
 *
 * Every assertion here fails on `main`: the registry had neither `setEffort`
 * nor `setPosture`, `setModel` had no route guard, the HTTP routes 404, and the
 * MCP tools didn't exist.
 */

import { describe, it, expect } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { SessionMode } from "@agentproto/acp/client"

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

/** Shared base — an idle agent session with the mandatory surface. */
function baseSession(overrides: Partial<AgentSessionLike>): AgentSessionLike {
  return {
    sessionId: "s",
    async *send() {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
    ...overrides,
  }
}

const mode = (id: string, name = id): SessionMode => ({ id, name })

// ── Live effort ─────────────────────────────────────────────────────────────

describe("SessionsRegistry.setEffort", () => {
  it("applies the switch, updates descriptor.effort, and emits config-changed{axis:effort}", async () => {
    const bus = createSessionEventBus()
    const seen: SessionEvent[] = []
    bus.onAny(ev => seen.push(ev))

    const reg = createSessionsRegistry({ persist: false, sessionEvents: bus })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: baseSession({
        async setEffort(effort: string) {
          return { applied: true, effort }
        },
      }),
      adapterSlug: "fake",
      label: "my-conversation",
    })

    const result = await reg.setEffort(desc.id, "high")
    expect(result).toEqual({ applied: true, effort: "high" })
    expect(reg.get(desc.id)?.effort).toBe("high")

    const configChanged = seen.find(ev => ev.type === "session:config-changed")
    expect(configChanged).toEqual({
      type: "session:config-changed",
      sessionId: desc.id,
      axis: "effort",
      value: "high",
      label: "my-conversation",
      ts: expect.any(String),
    })
    reg.shutdown()
  })

  it("soft-fails a model-rejected effort — descriptor and bus untouched (SPEC R7)", async () => {
    const bus = createSessionEventBus()
    const seen: SessionEvent[] = []
    bus.onAny(ev => seen.push(ev))

    const reg = createSessionsRegistry({ persist: false, sessionEvents: bus })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: baseSession({
        async setEffort() {
          return { applied: false, reason: "model does not support ultracode" }
        },
      }),
      adapterSlug: "fake",
      effort: "medium",
    })

    const result = await reg.setEffort(desc.id, "ultracode")
    expect(result).toEqual({
      applied: false,
      reason: "model does not support ultracode",
    })
    // A rejected effort changes nothing — the prior label stands, no event.
    expect(reg.get(desc.id)?.effort).toBe("medium")
    expect(seen.find(ev => ev.type === "session:config-changed")).toBeUndefined()
    reg.shutdown()
  })

  it("reports not-supported for a driver session with no setEffort method", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: baseSession({}),
      adapterSlug: "fake",
    })
    await expect(reg.setEffort(desc.id, "high")).resolves.toEqual({
      applied: false,
      reason: "not-supported",
    })
    reg.shutdown()
  })

  it("throws for an unknown session id and a non-agent-cli session", async () => {
    const reg = createSessionsRegistry({ persist: false })
    await expect(reg.setEffort("nope", "high")).rejects.toThrow(/no session "nope"/)
    const cmd = reg.recordCommand({
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
    await expect(reg.setEffort(cmd.id, "high")).rejects.toThrow(/not an agent-cli session/)
    reg.shutdown()
  })
})

// ── Live posture ────────────────────────────────────────────────────────────

describe("SessionsRegistry.setPosture", () => {
  it("applies live via setSessionMode when the posture maps to a NATIVE advertised mode", async () => {
    const bus = createSessionEventBus()
    const seen: SessionEvent[] = []
    bus.onAny(ev => seen.push(ev))

    const switchedTo: string[] = []
    const reg = createSessionsRegistry({ persist: false, sessionEvents: bus })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: baseSession({
        // claude-code's ACP wrapper advertises `plan` — the canonical posture
        // resolves onto it (case/separator-insensitive), so it's a live switch.
        availableModes: [mode("default", "Default"), mode("plan", "Plan")],
        async setSessionMode(modeId: string) {
          switchedTo.push(modeId)
          return { applied: true, modeId }
        },
      }),
      adapterSlug: "fake",
      label: "posture-conv",
    })

    const result = await reg.setPosture(desc.id, "plan")
    expect(result).toEqual({
      applied: true,
      posture: "plan",
      modeId: "plan",
      resolution: "native",
    })
    // The native harness mode was actually switched.
    expect(switchedTo).toEqual(["plan"])
    expect(reg.get(desc.id)?.posture).toBe("plan")

    const configChanged = seen.find(ev => ev.type === "session:config-changed")
    expect(configChanged).toEqual({
      type: "session:config-changed",
      sessionId: desc.id,
      axis: "posture",
      value: "plan",
      label: "posture-conv",
      ts: expect.any(String),
    })
    reg.shutdown()
  })

  it("returns requires-restart (no setSessionMode call) when there is NO native mode", async () => {
    const bus = createSessionEventBus()
    const seen: SessionEvent[] = []
    bus.onAny(ev => seen.push(ev))

    const switchedTo: string[] = []
    const reg = createSessionsRegistry({ persist: false, sessionEvents: bus })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: baseSession({
        // Harness advertises NO modes — a canonical posture can only be
        // prompt-injected, which rides the system prompt and needs a respawn.
        availableModes: [],
        async setSessionMode(modeId: string) {
          switchedTo.push(modeId)
          return { applied: true, modeId }
        },
      }),
      adapterSlug: "fake",
    })

    const result = await reg.setPosture(desc.id, "plan")
    expect(result).toEqual({
      applied: false,
      reason: "requires-restart",
      resolution: "prompt",
    })
    // NOT forced live — setSessionMode was never called, descriptor untouched.
    expect(switchedTo).toEqual([])
    expect(reg.get(desc.id)?.posture).toBeUndefined()
    expect(seen.find(ev => ev.type === "session:config-changed")).toBeUndefined()
    reg.shutdown()
  })

  it("a raw harness mode id the session no longer advertises is unavailable → requires-restart", async () => {
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: baseSession({
        availableModes: [mode("plan", "Plan")],
        async setSessionMode(modeId: string) {
          return { applied: true, modeId }
        },
      }),
      adapterSlug: "fake",
    })
    const result = await reg.setPosture(desc.id, { harnessModeId: "architect" })
    expect(result).toEqual({
      applied: false,
      reason: "requires-restart",
      resolution: "unavailable",
    })
    reg.shutdown()
  })
})

// ── Model↔route guard (R2) ──────────────────────────────────────────────────

describe("SessionsRegistry.setModel — model↔route guard (SPEC R2/§4.4)", () => {
  function trackingModelSession(applied: string[]): AgentSessionLike {
    return baseSession({
      async setModel(modelId: string) {
        applied.push(modelId)
        return { applied: true, model: modelId }
      },
    })
  }

  it("refuses a route-crossing switch WITHOUT calling the driver, suggesting a restart override", async () => {
    const applied: string[] = []
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: trackingModelSession(applied),
      adapterSlug: "fake",
      // Direct anthropic route (route defaults to the vendor).
      model: "anthropic/claude-opus-4-8",
    })

    const result = await reg.setModel(desc.id, "anthropic/claude-opus-4-8@openrouter")
    expect(result).toEqual({
      applied: false,
      reason: "requires-restart",
      suggestedOverride: {
        route: { gateway: "openrouter" },
        model: "anthropic/claude-opus-4-8@openrouter",
      },
    })
    // The live driver switch was never attempted, and the model is untouched.
    expect(applied).toEqual([])
    expect(reg.get(desc.id)?.model).toBe("anthropic/claude-opus-4-8")
    reg.shutdown()
  })

  it("allows a same-route switch to go live", async () => {
    const applied: string[] = []
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: trackingModelSession(applied),
      adapterSlug: "fake",
      model: "anthropic/claude-opus-4-8",
    })

    const result = await reg.setModel(desc.id, "anthropic/claude-sonnet-5")
    expect(result).toEqual({ applied: true, model: "anthropic/claude-sonnet-5" })
    expect(applied).toEqual(["anthropic/claude-sonnet-5"])
    expect(reg.get(desc.id)?.model).toBe("anthropic/claude-sonnet-5")
    reg.shutdown()
  })

  it("uses the explicit route axis (not just the model ref) as the current route", async () => {
    const applied: string[] = []
    const reg = createSessionsRegistry({ persist: false })
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: trackingModelSession(applied),
      adapterSlug: "fake",
      // Bare model, but a gateway route explicitly recorded on the session.
      route: { gateway: "moonshot" },
    })

    const result = await reg.setModel(desc.id, "anthropic/claude-opus-4-8")
    expect(result.applied).toBe(false)
    expect(result.reason).toBe("requires-restart")
    expect(result.suggestedOverride?.route).toEqual({ gateway: "anthropic" })
    expect(applied).toEqual([])
    reg.shutdown()
  })
})

// ── HTTP routes ─────────────────────────────────────────────────────────────

describe("POST /sessions/:id/{effort,posture} — HTTP", () => {
  it("effort: 200 applied, 400 missing, 404 unknown; auth-gated like /model", async () => {
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
      const s = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: baseSession({
          async setEffort(effort: string) {
            return { applied: true, effort }
          },
        }),
        adapterSlug: "fake",
      })
      const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }

      const okRes = await fetch(`http://127.0.0.1:${port}/sessions/${s.id}/effort`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ effort: "high" }),
      })
      expect(okRes.status).toBe(200)
      expect(await okRes.json()).toEqual({ ok: true, id: s.id, applied: true, effort: "high" })

      const missing = await fetch(`http://127.0.0.1:${port}/sessions/${s.id}/effort`, {
        method: "POST",
        headers: auth,
        body: "{}",
      })
      expect(missing.status).toBe(400)

      const unknown = await fetch(`http://127.0.0.1:${port}/sessions/nope/effort`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ effort: "high" }),
      })
      expect(unknown.status).toBe(404)

      const noAuth = await fetch(`http://127.0.0.1:${port}/sessions/${s.id}/effort`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ effort: "high" }),
      })
      expect(noAuth.status).toBe(401)
    } finally {
      await http.stop()
    }
  })

  it("posture: 200 native applied + 200 requires-restart when not native", async () => {
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
      const native = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: baseSession({
          availableModes: [mode("plan", "Plan")],
          async setSessionMode(modeId: string) {
            return { applied: true, modeId }
          },
        }),
        adapterSlug: "fake",
      })
      const nativeRes = await fetch(`http://127.0.0.1:${port}/sessions/${native.id}/posture`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ posture: "plan" }),
      })
      expect(nativeRes.status).toBe(200)
      expect(await nativeRes.json()).toEqual({
        ok: true,
        id: native.id,
        applied: true,
        posture: "plan",
        modeId: "plan",
        resolution: "native",
      })

      const noModes = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: baseSession({ availableModes: [] }),
        adapterSlug: "fake",
      })
      const restartRes = await fetch(`http://127.0.0.1:${port}/sessions/${noModes.id}/posture`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ posture: "plan" }),
      })
      expect(restartRes.status).toBe(200)
      expect(await restartRes.json()).toEqual({
        ok: true,
        id: noModes.id,
        applied: false,
        reason: "requires-restart",
        resolution: "prompt",
      })

      const missing = await fetch(`http://127.0.0.1:${port}/sessions/${native.id}/posture`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      expect(missing.status).toBe(400)
    } finally {
      await http.stop()
    }
  })
})

// ── MCP mirrors ─────────────────────────────────────────────────────────────

describe("agent_set_effort / agent_set_posture (MCP)", () => {
  async function mcpClient(registry: ReturnType<typeof createSessionsRegistry>) {
    const server = new McpServer({ name: "effort-posture-server", version: "0.0.0" })
    registerAgentTools(server, { registry })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "effort-posture-client", version: "0.0.0" })
    await client.connect(clientTransport)
    return client
  }

  it("agent_set_effort switches effort on a live session", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: baseSession({
        async setEffort(effort: string) {
          return { applied: true, effort }
        },
      }),
      adapterSlug: "fake",
    })
    const client = await mcpClient(registry)
    const result = (await client.callTool({
      name: "agent_set_effort",
      arguments: { sessionId: desc.id, effort: "xhigh" },
    })) as { isError?: boolean; content: Array<{ type: "text"; text: string }> }
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      ok: true,
      sessionId: desc.id,
      applied: true,
      effort: "xhigh",
    })
    expect(registry.get(desc.id)?.effort).toBe("xhigh")
    registry.shutdown()
  })

  it("agent_set_posture switches posture natively, and reports requires-restart otherwise", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const native = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: baseSession({
        availableModes: [mode("plan", "Plan")],
        async setSessionMode(modeId: string) {
          return { applied: true, modeId }
        },
      }),
      adapterSlug: "fake",
    })
    const client = await mcpClient(registry)

    const nativeResult = (await client.callTool({
      name: "agent_set_posture",
      arguments: { sessionId: native.id, posture: "plan" },
    })) as { isError?: boolean; content: Array<{ type: "text"; text: string }> }
    expect(nativeResult.isError).toBeUndefined()
    expect(JSON.parse(nativeResult.content[0]!.text)).toEqual({
      ok: true,
      sessionId: native.id,
      applied: true,
      posture: "plan",
      modeId: "plan",
      resolution: "native",
    })

    const noModes = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: baseSession({ availableModes: [] }),
      adapterSlug: "fake",
    })
    const restartResult = (await client.callTool({
      name: "agent_set_posture",
      arguments: { sessionId: noModes.id, posture: "bypass" },
    })) as { isError?: boolean; content: Array<{ type: "text"; text: string }> }
    expect(JSON.parse(restartResult.content[0]!.text)).toEqual({
      ok: true,
      sessionId: noModes.id,
      applied: false,
      reason: "requires-restart",
      resolution: "prompt",
    })
    registry.shutdown()
  })
})
