/**
 * `POST /sessions/:id/messages` from an unverified (claimed external) sender,
 * `defaults.messaging.anonymousSend`: "label" delivers prefixed and capped at
 * steer; "block" keeps `forbidden_recipient`. Read fresh per request.
 */

import { describe, it, expect, vi } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createMcpServer } from "@agentproto/mcp-server"

import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { DEFAULT_MESSAGING_DEFAULTS, type ResolvedMessagingDefaults } from "../messaging-defaults.js"
import { createSessionMessage } from "../session-message.js"
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

async function route(anonymousSend: "block" | "label", urgency = "interrupt") {
  const tmp = mkdtempSync(join(tmpdir(), "messages-anon-route-"))
  const registry = createSessionsRegistry({ persist: false, transcriptDir: tmp })
  registry.touchExternal({ id: "claude-desktop", host: "claude-desktop" })
  const recipient = registry.spawnAgent({
    workspaceSlug: "agentik-studio",
    cwd: "/tmp",
    agentSession: idle("r"),
    adapterSlug: "fake",
  })
  const send = vi.spyOn(registry, "sendMessage")
  vi.spyOn(registry, "enqueuePrompt").mockResolvedValue({ queued: false })
  const resolveAgentAdapter: AgentAdapterResolver = async () => ({ startSession: vi.fn(), commandPreview: "x" })
  const messagingDefaultsFor = async (): Promise<ResolvedMessagingDefaults> => ({
    ...DEFAULT_MESSAGING_DEFAULTS,
    allowSameWorkspace: false,
    anonymousSend,
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
    const res = await fetch(`http://127.0.0.1:${port}/sessions/${recipient.id}/messages?callerSessionId=claude-desktop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ping from chat", urgency }),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, send }
  } finally {
    await http.stop()
    registry.shutdown()
    rmSync(tmp, { recursive: true, force: true })
  }
}

describe("POST /sessions/:id/messages - anonymousSend", () => {
  it("label: delivers the claude-desktop message prefixed and capped at steer", async () => {
    const r = await route("label")
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, unverified: true, urgencyApplied: "steer" })
    expect(r.send.mock.calls[0]![0].text).toBe("[unverified sender: claude-desktop] ping from chat")
  })

  it("block: keeps forbidden_recipient", async () => {
    const r = await route("block")
    expect(r.status).toBe(403)
    expect(r.body).toMatchObject({ error: "forbidden_recipient" })
    expect(r.send).not.toHaveBeenCalled()
  })
})

/**
 * HTTP parity for the reply rule: a VERIFIED session replying to an unverified
 * original gets the same `[reply to unverified sender: ...] ` prefix the
 * `message_send` tool emits, derived from the ORIGINAL sender — not from the
 * replier's own (verified) identity — and the envelope keeps the replier.
 */
async function replyRoute(urgency = "interrupt") {
  const tmp = mkdtempSync(join(tmpdir(), "messages-reply-route-"))
  const registry = createSessionsRegistry({ persist: false, transcriptDir: tmp })
  registry.touchExternal({ id: "claude-desktop", host: "claude-desktop" })
  const replier = registry.spawnAgent({
    workspaceSlug: "agentik-studio",
    cwd: "/tmp",
    agentSession: idle("r"),
    adapterSlug: "fake",
    label: "brain",
  })
  vi.spyOn(registry, "enqueuePrompt").mockResolvedValue({ queued: false })
  const send = vi.spyOn(registry, "sendMessage")
  const original = createSessionMessage({
    to: replier.id,
    from: { sessionId: "claude-desktop", relation: "granted", unverified: true },
    text: "ping from chat",
  })
  await registry.sendMessage(original, { source: "t", origin: "t" })
  send.mockClear()
  const resolveAgentAdapter: AgentAdapterResolver = async () => ({ startSession: vi.fn(), commandPreview: "x" })
  const messagingDefaultsFor = async (): Promise<ResolvedMessagingDefaults> => ({
    ...DEFAULT_MESSAGING_DEFAULTS,
    allowSameWorkspace: false,
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
    const res = await fetch(
      `http://127.0.0.1:${port}/sessions/claude-desktop/messages?callerSessionId=${replier.id}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "answer", replyTo: original.id, urgency }),
      },
    )
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
      send,
      replierId: replier.id,
    }
  } finally {
    await http.stop()
    registry.shutdown()
    rmSync(tmp, { recursive: true, force: true })
  }
}

describe("POST /sessions/:id/messages - reply to an unverified original", () => {
  it("labels from the original sender, not the verified replier", async () => {
    const r = await replyRoute()
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, replyToUnverified: true })
    const sent = r.send.mock.calls[0]![0]
    expect(sent.text).toBe("[reply to unverified sender: claude-desktop] answer")
    expect(sent.from.sessionId).toBe(r.replierId)
    expect(sent.from.unverified).toBeUndefined()
    expect(sent.from.anonymous).toBeUndefined()
  })
})
