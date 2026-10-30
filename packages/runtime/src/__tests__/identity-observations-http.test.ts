/**
 * `GET /identity` persistence across daemon restarts, through the real HTTP
 * server. Deliberately does NOT import `identity-observations.js`: the server
 * is the unit under test, and this file must run against the unmodified
 * server for the red run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
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
  return {
    start() {},
    stop() {},
    async fireNow() {},
  }
}

interface Server {
  base: string
  stop: () => Promise<void>
}

async function startServer(opts: {
  observations?: { path: string; flushMs?: number }
  buildSha?: string
}): Promise<Server> {
  const port = await freePort()
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    mcpServerFactory: async () => {
      const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
      server.tool("probe", "probe", {}, async () => ({ content: [{ type: "text" as const, text: "ok" }] }))
      return server
    },
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    meta: {
      workspace: process.cwd(),
      registered: [],
      ...(opts.buildSha ? { build: { sha: opts.buildSha } } : {}),
    },
    identity: {
      mode: () => "shadow",
      ...(opts.observations ? { observations: opts.observations } : {}),
    },
  } as never)
  return { base: `http://127.0.0.1:${port}`, stop: () => http.stop() }
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "identity-persist", version: "0" } },
})

async function mcp(base: string): Promise<void> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: INITIALIZE,
  })
  await res.text()
}

async function identity(base: string): Promise<any> {
  return (await fetch(`${base}/identity`)).json()
}

async function identityAfterAnonymous(base: string, n: number): Promise<any> {
  let id: any
  await vi.waitFor(
    async () => {
      id = await identity(base)
      expect(id?.counters?.anonymous).toBe(n)
    },
    { timeout: 3_000 },
  )
  return id
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"))
}

let tmp: string
let observationsPath: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "identity-persist-"))
  observationsPath = join(tmp, "identity-observations.json")
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe("GET /identity persistence", () => {
  it("a restart adds up: 3 requests, stop, 2 more on the same path, 5 total with the same since", async () => {
    const first = await startServer({ observations: { path: observationsPath, flushMs: 50 } })
    let firstSince: string
    try {
      await mcp(first.base)
      await mcp(first.base)
      await mcp(first.base)
      firstSince = (await identityAfterAnonymous(first.base, 3)).since
      expect(typeof firstSince).toBe("string")
    } finally {
      await first.stop()
    }

    const second = await startServer({ observations: { path: observationsPath, flushMs: 50 } })
    try {
      await mcp(second.base)
      await mcp(second.base)
      const id = await identityAfterAnonymous(second.base, 5)
      expect(id.since).toBe(firstSince)
      expect(id.boots).toHaveLength(2)
      expect(typeof id.bootedAt).toBe("string")
      expect(new Date(id.bootedAt).getTime()).toBeGreaterThanOrEqual(new Date(id.since).getTime())
    } finally {
      await second.stop()
    }
  })

  it("stop() flushes the totals even with a huge flushMs", async () => {
    const srv = await startServer({ observations: { path: observationsPath, flushMs: 3_600_000 } })
    await mcp(srv.base)
    await mcp(srv.base)
    await identityAfterAnonymous(srv.base, 2)
    await srv.stop()
    expect(readJson(observationsPath).totals.counters.anonymous).toBe(2)
  })

  it("the periodic flush writes while the server is still running", async () => {
    const srv = await startServer({ observations: { path: observationsPath, flushMs: 50 } })
    try {
      await mcp(srv.base)
      await vi.waitFor(
        () => {
          expect(existsSync(observationsPath)).toBe(true)
          expect(readJson(observationsPath).totals.counters.anonymous).toBe(1)
        },
        { timeout: 3_000 },
      )
    } finally {
      await srv.stop()
    }
  })

  it("a corrupt file is ignored, the server answers, and stop() rewrites valid JSON", async () => {
    writeFileSync(observationsPath, "{not json")
    const srv = await startServer({ observations: { path: observationsPath, flushMs: 50 } })
    try {
      const id = await identity(srv.base)
      expect(id.counters.anonymous).toBe(0)
      await mcp(srv.base)
      await identityAfterAnonymous(srv.base, 1)
    } finally {
      await srv.stop()
    }
    expect(() => readJson(observationsPath)).not.toThrow()
    expect(readJson(observationsPath).totals.counters.anonymous).toBe(1)
  })

  it("without observations there are no boots and no file is written", async () => {
    const srv = await startServer({})
    try {
      const id = await identity(srv.base)
      expect(id.boots).toBeUndefined()
    } finally {
      await srv.stop()
    }
    expect(readdirSync(tmp).filter(name => name === "identity-observations.json")).toEqual([])
  })

  it("records the build sha of the booting daemon", async () => {
    const srv = await startServer({ observations: { path: observationsPath, flushMs: 50 }, buildSha: "abc123" })
    try {
      const id = await identityAfterAnonymous(srv.base, 0)
      expect(id.boots[0].build).toBe("abc123")
    } finally {
      await srv.stop()
    }
  })
})
