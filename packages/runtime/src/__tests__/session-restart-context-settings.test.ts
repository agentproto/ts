/**
 * `POST /sessions/:id/restart` accepts the AIP-46 name of the context block,
 * `contextSettings`, next to the legacy `contextContinuity` (AIP-46 §Session
 * context rule 4). Both land in the same per-key override the restart core
 * overlays on the prior session's resolved policy.
 */

import { afterEach, describe, expect, it } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createRuntimeEvents } from "../events.js"
import { resolveContextContinuityPolicy } from "../context-continuity.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

const TOKEN = "restart-context-settings-token"

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

let counter = 0
function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `acp_ctx_${counter++}`,
    // eslint-disable-next-line require-yield
    async *send() {},
    async cancel() {},
    async close() {},
  }
}

const resolver: AgentAdapterResolver = async () => ({
  startSession: async () => fakeAgentSession(),
  commandPreview: "mock-adapter",
})

let teardown: (() => Promise<void>) | undefined

afterEach(async () => {
  if (teardown) await teardown().catch(() => {})
  teardown = undefined
})

async function boot() {
  const port = await freePort()
  const registry = createSessionsRegistry({
    persist: false,
    sessionEvents: createSessionEventBus(),
  })
  const http = await startHttpServer({
    port,
    token: TOKEN,
    auth: { mode: "none" },
    mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    sessions: registry,
    resolveAgentAdapter: resolver,
    meta: { workspace: process.cwd(), registered: [] },
  })
  teardown = () => http.stop()
  const prev = registry.spawnAgent({
    workspaceSlug: "default",
    cwd: process.cwd(),
    agentSession: fakeAgentSession(),
    adapterSlug: "mock",
    contextContinuity: resolveContextContinuityPolicy(undefined, undefined, undefined, {
      autoCompactAtTokens: 120_000,
      hardStopAtPct: 92,
    }),
  })
  const restart = async (body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/sessions/${prev.id}/restart`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as Record<string, any> }
  }
  return { restart }
}

describe("POST /sessions/:id/restart — contextSettings", () => {
  it("applies a contextSettings override per key over the prior session's policy", async () => {
    const { restart } = await boot()
    const res = await restart({ contextSettings: { autoCompactAtTokens: 90_000 } })
    expect(res.status).toBe(200)
    const policy = (res.body.contextContinuity ?? res.body.descriptor?.contextContinuity) as
      | { autoCompactAtTokens?: number; hardStopAtPct?: number }
      | undefined
    expect(policy?.autoCompactAtTokens).toBe(90_000)
    expect(policy?.hardStopAtPct).toBe(92)
  })

  it("when both names are sent, contextSettings wins key by key and the alias-only key survives", async () => {
    const { restart } = await boot()
    const res = await restart({
      contextContinuity: { autoCompactAtTokens: 100_000, warnAtPct: 50 },
      contextSettings: { autoCompactAtTokens: 90_000 },
    })
    expect(res.status).toBe(200)
    const policy = (res.body.contextContinuity ?? res.body.descriptor?.contextContinuity) as
      | { autoCompactAtTokens?: number; warnAtPct?: number }
      | undefined
    expect(policy?.autoCompactAtTokens).toBe(90_000)
    expect(policy?.warnAtPct).toBe(50)
  })

  it("rejects a malformed contextSettings override as a 400 naming the field", async () => {
    const { restart } = await boot()
    const res = await restart({ contextSettings: { warnAtPct: 101 } })
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toMatch(/restart contextSettings override/)
  })
})
