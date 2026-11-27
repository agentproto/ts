/**
 * `events/stream` over a real HTTP server on an ephemeral port: SSE framing, header validation, JSON errors before
 * any frame, release on client disconnect, final frame on server shutdown, and the feature switch.
 */

import "../sentinel-platform.js"

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"
import { createFakeSentinelProvider } from "@agentproto/sentinel"

import { startHttpServer, type RuntimeHttpServerOptions } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import { toJournalEvent } from "../mcp-events/adapter.js"
import { daemonBearerPrincipal } from "../mcp-events/events-registry.js"
import { createPollJournal, journalKey, type PollJournal } from "../mcp-events/poll-journal.js"
import { createPollLeaseManager, type PollLeaseManager } from "../mcp-events/poll-lease.js"
import { createStreamSlots, openEventsStream, type StreamSlots } from "../mcp-events/stream.js"
import { resolveEventsStream } from "../mcp-config.js"
import type { EventsStreamHandler } from "../mcp-modern/index.js"

const NAME = "github.pull_request.closed"
const ARGS = { repo: "agentproto/ts", number: 1428 }
const KEY = journalKey(NAME, ARGS)
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
}

let dir: string
let journal: PollJournal
let leases: PollLeaseManager
let slots: StreamSlots

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-events-stream-http-"))
  journal = createPollJournal({ dir })
  leases = createPollLeaseManager({
    journal,
    resolveProvider: async () => createFakeSentinelProvider({ slug: "local-gh" }),
    toEvent: toJournalEvent,
    background: false,
  })
  slots = createStreamSlots()
})
afterEach(async () => {
  await leases.stop()
  rmSync(dir, { recursive: true, force: true })
})

const handler = (): EventsStreamHandler => ({
  open: async ({ id, params }) => {
    const stream = await openEventsStream(params as never, { principal: daemonBearerPrincipal(), journal, leases, slots, subscriptionId: id })
    return sink => stream.run(sink)
  },
})

async function serve(extra: Partial<RuntimeHttpServerOptions> = {}) {
  const port = await freePort()
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    meta: { workspace: process.cwd(), registered: [] },
    mcpModern: { eventsStream: async () => handler() },
    ...extra,
  })
  return { base: `http://127.0.0.1:${port}`, http }
}

function streamRequest(
  base: string,
  opts: { headers?: Record<string, string | undefined>; params?: Record<string, unknown>; signal?: AbortSignal } = {},
) {
  const headers: Record<string, string> = {}
  const merged: Record<string, string | undefined> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": "events/stream",
    "mcp-name": NAME,
    ...opts.headers,
  }
  for (const [k, v] of Object.entries(merged)) if (v !== undefined) headers[k] = v
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "events/stream",
      params: { name: NAME, arguments: ARGS, cursor: null, ...opts.params, _meta: META },
    }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
}

/** Read raw SSE text until `until(text)` holds or the body ends. */
async function readUntil(res: Response, until: (text: string) => boolean): Promise<{ text: string; ended: boolean }> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ""
  for (;;) {
    if (until(text)) {
      reader.releaseLock()
      return { text, ended: false }
    }
    const { value, done } = await reader.read()
    if (done) return { text, ended: true }
    text += decoder.decode(value, { stream: true })
  }
}

function frames(text: string): Array<Record<string, any>> {
  return text
    .split("\n\n")
    .filter(chunk => chunk.length > 0)
    .map(chunk => {
      expect(chunk.startsWith("data: ")).toBe(true)
      expect(chunk.split("\n")).toHaveLength(1)
      return JSON.parse(chunk.slice("data: ".length))
    })
}

async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error("condition never held")
}

describe("events/stream over HTTP", () => {
  it("answers text/event-stream with x-accel-buffering:no, one data: frame per JSON-RPC message, no id: line, no comment", async () => {
    const { base, http } = await serve()
    try {
      const client = new AbortController()
      const res = await streamRequest(base, { signal: client.signal })
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toBe("text/event-stream")
      expect(res.headers.get("x-accel-buffering")).toBe("no")
      const { text } = await readUntil(res, t => t.includes("\n\n"))
      for (const line of text.split("\n")) {
        expect(line.startsWith("id:")).toBe(false)
        expect(line.startsWith(":")).toBe(false)
      }
      const [active] = frames(text)
      expect(active).toMatchObject({
        jsonrpc: "2.0",
        method: "notifications/events/active",
        params: { truncated: false, heartbeatMs: 30_000, _meta: { "io.modelcontextprotocol/subscriptionId": 1 } },
      })
      client.abort()
    } finally {
      await http.stop()
    }
  })

  it("Mcp-Name missing or different is -32020 with HTTP 400", async () => {
    const { base, http } = await serve()
    try {
      for (const name of [undefined, "github.pull_request.synchronize"]) {
        const res = await streamRequest(base, { headers: { "mcp-name": name } })
        expect(res.status).toBe(400)
        expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32020)
      }
      expect(slots.size()).toBe(0)
    } finally {
      await http.stop()
    }
  })

  it("an Accept that does not allow text/event-stream is 406", async () => {
    const { base, http } = await serve()
    try {
      const res = await streamRequest(base, { headers: { accept: "application/json" } })
      expect(res.status).toBe(406)
      expect(slots.size()).toBe(0)
    } finally {
      await http.stop()
    }
  })

  it("a validation error is an ordinary application/json JSON-RPC error, no stream opened", async () => {
    const { base, http } = await serve()
    try {
      const res = await streamRequest(base, { params: { arguments: { repo: "agentproto/ts" } } })
      expect(res.headers.get("content-type")).toBe("application/json")
      const body = (await res.json()) as Record<string, unknown>
      expect(body).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: -32602 } })
      expect(slots.size()).toBe(0)
    } finally {
      await http.stop()
    }
  })

  it("closing the client socket releases the stream slot and the lease hold", async () => {
    const { base, http } = await serve()
    try {
      const client = new AbortController()
      const res = await streamRequest(base, { signal: client.signal })
      await readUntil(res, t => t.includes("\n\n"))
      expect(slots.size()).toBe(1)
      expect(journal.listenerCount(KEY)).toBe(1)
      client.abort()
      await eventually(() => slots.size() === 0)
      expect(journal.listenerCount(KEY)).toBe(0)
    } finally {
      await http.stop()
    }
  })

  it("a server shutdown sends the final frame before the stream ends", async () => {
    const { base, http } = await serve()
    const res = await streamRequest(base)
    await readUntil(res, t => t.includes("\n\n"))
    const reading = readUntil(res, () => false)
    await http.stop()
    const { text, ended } = await reading
    expect(ended).toBe(true)
    expect(frames(text).at(-1)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { resultType: "complete", _meta: { "io.modelcontextprotocol/subscriptionId": 1 } },
    })
    expect(slots.size()).toBe(0)
  })

  it("switched off (mcp.eventsStream:false) events/stream is 404 -32601, with a correct Mcp-Name", async () => {
    const { base, http } = await serve({ mcpModern: { eventsStream: async () => undefined } })
    try {
      const res = await streamRequest(base)
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32601)
    } finally {
      await http.stop()
    }
  })

  it("mcp.eventsStream resolves false when switched off, or when mcp.eventsExtension is off", async () => {
    expect(await resolveEventsStream(async () => ({}))).toBe(true)
    expect(await resolveEventsStream(async () => ({ mcp: { eventsStream: false } }))).toBe(false)
    expect(await resolveEventsStream(async () => ({ mcp: { eventsExtension: false } }))).toBe(false)
  })
})

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
  return {
    start() {},
    stop() {},
    async fireNow() {},
  }
}
