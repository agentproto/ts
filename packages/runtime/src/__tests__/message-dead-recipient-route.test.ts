/**
 * Dead-recipient route for `message.*` (delivery kernel, PR 12b): behind
 * `delivery.apply.types["message.*"]`, a message to a dead session goes to
 * its live parent with a `[for <id>] ` prefix and the ledger says
 * `routedTo`. Flag off, no parent, or a dead parent keep today's behavior.
 */

import { describe, it, expect } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"
import type { DeliveryApplyConfig } from "@agentproto/delivery"

import { registerMessageTools } from "../message-tools.js"
import { createSessionsRegistry, type AgentSessionLike, type SessionsRegistry } from "../sessions.js"
import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { DEFAULT_MESSAGING_DEFAULTS } from "../messaging-defaults.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

const ON: DeliveryApplyConfig = { types: { "message.*": true } }

function idle(): AgentSessionLike {
  return {
    sessionId: "acp_test",
    // eslint-disable-next-line require-yield
    async *send() {
      return
    },
    async cancel() {},
    async close() {},
  }
}

function spawn(registry: SessionsRegistry, parentSessionId?: string) {
  return registry.spawnAgent({
    workspaceSlug: "ws-acme",
    cwd: "/tmp",
    agentSession: idle(),
    adapterSlug: "mock",
    ...(parentSessionId ? { parentSessionId } : {}),
    depth: parentSessionId ? 1 : 0,
  })
}

/** parent -> child (dead), plus an unrelated same-workspace sender. */
function tree(opts: { killParent?: boolean; orphanChild?: boolean } = {}) {
  const registry = createSessionsRegistry({ persist: false })
  const parent = spawn(registry)
  const child = opts.orphanChild ? spawn(registry) : spawn(registry, parent.id)
  const sender = spawn(registry)
  registry.kill(child.id)
  if (opts.killParent) registry.kill(parent.id)
  return { registry, parent, child, sender }
}

async function callSend(
  registry: SessionsRegistry,
  callerSessionId: string,
  to: string,
  apply: DeliveryApplyConfig | undefined,
  ledgerPath: string,
) {
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  registerMessageTools(server, {
    registry,
    callerSessionId,
    ...(apply ? { deliveryApply: apply } : {}),
    ledgerPath,
  })
  const [c, s] = InMemoryTransport.createLinkedPair()
  await server.connect(s)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(c)
  try {
    const res = (await client.callTool({
      name: "message_send",
      arguments: { to, text: "ship it", urgency: "fyi" },
    })) as { content: Array<{ text: string }>; isError?: boolean }
    return { body: JSON.parse(res.content[0]!.text) as Record<string, unknown>, isError: res.isError === true }
  } finally {
    await client.close()
  }
}

function ledgerLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(l => JSON.parse(l) as Record<string, unknown>)
}

describe("message_send - dead recipient route (delivery.apply message.*)", () => {
  it("flag on: a message to a dead child reaches the live parent with the prefix and the ledger says routedTo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dead-route-"))
    const ledger = join(dir, "ledger.jsonl")
    try {
      const { registry, parent, child, sender } = tree()
      const r = await callSend(registry, sender.id, child.id, ON, ledger)
      expect(r.isError).toBe(false)
      expect(r.body).toMatchObject({ ok: true, to: parent.id, routedFrom: child.id })
      const inbox = registry.listInbox(parent.id) ?? []
      expect(inbox).toHaveLength(1)
      expect(inbox[0]!.text).toBe(`[for ${child.id}] ship it`)
      const lines = ledgerLines(ledger)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({
        producer: "message",
        type: "message.report",
        applied: true,
        outcome: "retargeted",
        routedTo: parent.id,
        target: { kind: "session", id: child.id },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("flag off: unchanged, the dead child refuses and nothing reaches the parent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dead-route-"))
    const ledger = join(dir, "ledger.jsonl")
    try {
      const offs: Array<DeliveryApplyConfig | undefined> = [
        undefined,
        { types: { "message.*": false } },
        { types: { "session.*": true } },
      ]
      for (const apply of offs) {
        const { registry, parent, child, sender } = tree()
        const r = await callSend(registry, sender.id, child.id, apply, ledger)
        expect(r.isError).toBe(true)
        expect(r.body).toMatchObject({ ok: false, error: "not_delivered" })
        expect(registry.listInbox(parent.id) ?? []).toHaveLength(0)
      }
      expect(ledgerLines(ledger)).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("flag on, no parent: falls back to today's refusal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dead-route-"))
    try {
      const { registry, child, sender } = tree({ orphanChild: true })
      const r = await callSend(registry, sender.id, child.id, ON, join(dir, "l.jsonl"))
      expect(r.isError).toBe(true)
      expect(r.body).toMatchObject({ ok: false, error: "not_delivered" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("flag on, parent dead too: falls back to today's refusal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dead-route-"))
    try {
      const { registry, child, sender } = tree({ killParent: true })
      const r = await callSend(registry, sender.id, child.id, ON, join(dir, "l.jsonl"))
      expect(r.isError).toBe(true)
      expect(r.body).toMatchObject({ ok: false, error: "not_delivered" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("flag on, live recipient: delivered as before, no route", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dead-route-"))
    const ledger = join(dir, "ledger.jsonl")
    try {
      const registry = createSessionsRegistry({ persist: false })
      const parent = spawn(registry)
      const child = spawn(registry, parent.id)
      const r = await callSend(registry, parent.id, child.id, ON, ledger)
      expect(r.body).toMatchObject({ ok: true, to: child.id })
      expect(r.body).not.toHaveProperty("routedFrom")
      expect(ledgerLines(ledger)[0]).toMatchObject({ applied: true, outcome: "inbox" })
      expect(ledgerLines(ledger)[0]).not.toHaveProperty("routedTo")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

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

describe("POST /sessions/:id/messages - dead recipient route", () => {
  async function post(apply: DeliveryApplyConfig | undefined) {
    const dir = mkdtempSync(join(tmpdir(), "dead-route-http-"))
    const ledger = join(dir, "ledger.jsonl")
    const { registry, parent, child, sender } = tree()
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({ startSession: async () => idle(), commandPreview: "x" }) as never
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
      resolveMessagingDefaults: async () => ({ ...DEFAULT_MESSAGING_DEFAULTS, ...(apply ? { deliveryApply: apply } : {}) }),
      ledgerPath: ledger,
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/sessions/${child.id}/messages?callerSessionId=${sender.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "ship it", urgency: "fyi" }),
      })
      return {
        status: res.status,
        body: (await res.json()) as Record<string, unknown>,
        parentInbox: registry.listInbox(parent.id) ?? [],
        lines: ledgerLines(ledger),
        parent,
        child,
      }
    } finally {
      await http.stop()
      registry.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it("flag on: routes to the parent, prefix, ledger routedTo", async () => {
    const r = await post(ON)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, id: r.parent.id, routedFrom: r.child.id })
    expect(r.parentInbox.map(m => m.text)).toEqual([`[for ${r.child.id}] ship it`])
    expect(r.lines[0]).toMatchObject({ applied: true, outcome: "retargeted", routedTo: r.parent.id })
  })

  it("flag off: 409 session_not_alive as before, ledger dropped without routedTo", async () => {
    const r = await post(undefined)
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ error: "session_not_alive" })
    expect(r.parentInbox).toHaveLength(0)
    expect(r.lines[0]).toMatchObject({ applied: false, outcome: "dropped" })
    expect(r.lines[0]).not.toHaveProperty("routedTo")
  })
})
