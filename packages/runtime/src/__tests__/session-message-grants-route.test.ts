/**
 * `POST /sessions/:id/messages` reads explicit `defaults.messaging.grants`
 * from the config seam (`resolveMessagingDefaults`) and the shared messaging
 * context: a refused pair becomes allowed with relation `granted`, and with
 * no (or no matching) grants the previous refusal stands.
 */

import { describe, it, expect, vi } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createMcpServer } from "@agentproto/mcp-server"
import type { Grant } from "@agentproto/policy"

import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { DEFAULT_MESSAGING_DEFAULTS, type ResolvedMessagingDefaults } from "../messaging-defaults.js"
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

const conversations: ConversationStore = {
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
const heartbeat: HeartbeatRunner = { start() {}, stop() {}, async fireNow() {} }

function idle(sessionId: string): AgentSessionLike {
  return {
    sessionId,
    // eslint-disable-next-line require-yield
    async *send() {
      return
    },
    async cancel() {},
    async close() {},
  }
}

const grantTo = (sessionId: string): Grant => ({
  principal: "*",
  effect: "allow",
  actions: [{ action: "session:message", scope: sessionId }],
})

/** Spawn a fresh refused cross-workspace pair and post one message. */
async function route(grants: Grant[]) {
  const tmp = mkdtempSync(join(tmpdir(), "messages-grants-route-"))
  const registry = createSessionsRegistry({ persist: false, transcriptDir: tmp })
  const sender = registry.spawnAgent({
    workspaceSlug: "app-agentik-pygmalion",
    cwd: "/tmp",
    agentSession: idle("s"),
    adapterSlug: "fake",
  })
  const recipient = registry.spawnAgent({
    workspaceSlug: "agentik-studio",
    cwd: "/tmp",
    agentSession: idle("r"),
    adapterSlug: "fake",
  })
  const resolveAgentAdapter: AgentAdapterResolver = async () => ({ startSession: vi.fn(), commandPreview: "x" })
  const messagingDefaultsFor = async (): Promise<ResolvedMessagingDefaults> => ({
    ...DEFAULT_MESSAGING_DEFAULTS,
    allowSameWorkspace: false,
    grants,
  })
  const port = await freePort()
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "t", version: "0" })).server,
    conversations,
    events: createRuntimeEvents(),
    heartbeat,
    sessions: registry,
    resolveAgentAdapter,
    resolveMessagingDefaults: messagingDefaultsFor,
    meta: { workspace: process.cwd(), registered: [] },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${port}/sessions/${recipient.id}/messages?callerSessionId=${sender.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "the launch copy is ready", urgency: "fyi" }),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, sender, recipient }
  } finally {
    await http.stop()
    registry.shutdown()
    rmSync(tmp, { recursive: true, force: true })
  }
}

describe("POST /sessions/:id/messages - explicit grants from config", () => {
  it("admits a refused pair with relation granted and no peer-unverified warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const admitted = await route([{ principal: "*", effect: "allow", actions: [{ action: "session:message" }] }])
      expect(admitted.status).toBe(200)
      expect(admitted.body).toMatchObject({ ok: true, relation: "granted" })
      expect(warn.mock.calls.map(c => c.join(" ")).join("\n")).not.toContain("peer-unverified")
    } finally {
      warn.mockRestore()
    }
  })

  it("keeps the previous refusal when no grant is configured", async () => {
    const refused = await route([])
    expect(refused.status).toBe(403)
    expect(refused.body).toMatchObject({ error: "forbidden_recipient" })
  })

  it("keeps the previous refusal when no grant matches", async () => {
    const refused = await route([grantTo("some-other-session")])
    expect(refused.status).toBe(403)
    expect(refused.body).toMatchObject({ error: "forbidden_recipient" })
  })
})
