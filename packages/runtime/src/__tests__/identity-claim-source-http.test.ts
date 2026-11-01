/**
 * The claim-source label of a claim-only caller, through the real HTTP
 * server (`GET /identity` `thisBoot` and the `[identity]` log line).
 * Deliberately does NOT import `identity-claim-source.js`: the server is the
 * unit under test, and this file must run against the unmodified server for
 * the red run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, request as httpRequest } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
  type SessionsRegistry,
} from "../sessions.js"
import {
  attachSessionCredentialStore,
  clearSessionCredentials,
  mintSessionToken,
} from "../session-credentials.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

const TOKEN_HEADER = "x-agentproto-session-token"
const CALLER_HEADER = "x-agentproto-caller-session-id"

type Mode = "off" | "shadow" | "enforce"

interface IdentityReport {
  mode: string
  since: string
  bootedAt: string
  counters: Record<string, number>
  claimOnlyByClass: Record<string, number>
  thisBoot: {
    since: string
    counters: Record<string, number>
    claimOnlyByClass: Record<string, number>
    claimOnlyBySource: Record<string, number>
    deliveredBySource: Record<string, number>
  }
  [key: string]: unknown
}

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

let acpCounter = 0
function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `acp_claim_source_${acpCounter++}`,
    async *send(): AsyncIterable<AgentStreamEvent> {
      yield { kind: "turn-end", reason: "completed" } as AgentStreamEvent
    },
    async cancel() {},
    async close() {},
  }
}

interface Fixture {
  registry: SessionsRegistry
  delivered: string
  token: string
  undelivered: string
}

function fixture(): Fixture {
  const registry = createSessionsRegistry({ persist: false })
  const spawn = (adapterSlug: string): string =>
    registry.spawnAgent({
      workspaceSlug: "claim-source",
      cwd: tmp,
      agentSession: fakeAgentSession(),
      adapterSlug,
    }).id
  const delivered = spawn("claude-code")
  const token = mintSessionToken(delivered)
  const undelivered = spawn("codex")
  return { registry, delivered, token, undelivered }
}

interface Server {
  base: string
  stop: () => Promise<void>
}

async function startServer(opts: {
  mode?: Mode
  registry: SessionsRegistry
  observations?: { path: string; flushMs?: number }
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
    meta: { workspace: process.cwd(), registered: [] },
    sessions: opts.registry,
    identity: {
      mode: () => opts.mode ?? "shadow",
      ...(opts.observations ? { observations: opts.observations } : {}),
    },
  } as never)
  return { base: `http://127.0.0.1:${port}`, stop: () => http.stop() }
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "claim-source", version: "0" } },
})

async function mcp(
  base: string,
  query: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetch(`${base}/mcp${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: INITIALIZE,
  })
  const text = await res.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: res.status, json, text }
}

async function getMcp(base: string, query: string, headers: Record<string, string> = {}): Promise<void> {
  // A GET on /mcp opens an SSE stream, so drop the socket as soon as the
  // response starts: the identity observer has already run.
  await new Promise<void>((resolve, reject) => {
    const req = httpRequest(
      `${base}/mcp${query}`,
      { method: "GET", headers: { accept: "application/json, text/event-stream", ...headers } },
      res => {
        res.destroy()
        resolve()
      },
    )
    req.on("error", reject)
    req.end()
  })
}

async function identity(base: string): Promise<IdentityReport> {
  return (await (await fetch(`${base}/identity`)).json()) as IdentityReport
}

async function identityAfter(base: string, predicate: (id: IdentityReport) => boolean): Promise<IdentityReport> {
  let id: IdentityReport | undefined
  await vi.waitFor(
    async () => {
      id = await identity(base)
      expect(predicate(id)).toBe(true)
    },
    { timeout: 3_000 },
  )
  return id as IdentityReport
}

const claimOnly = (id: IdentityReport): number => id.counters.claim_only ?? 0

let tmp: string
let observationsPath: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "identity-claim-source-"))
  observationsPath = join(tmp, "identity-observations.json")
  clearSessionCredentials()
  attachSessionCredentialStore({ path: join(tmp, "creds.json") })
})
afterEach(() => {
  clearSessionCredentials()
  rmSync(tmp, { recursive: true, force: true })
})

describe("GET /identity thisBoot claim sources", () => {
  it("(a) records the client, verb and query carrier of a delivered claim-only POST", async () => {
    const f = fixture()
    const srv = await startServer({ registry: f.registry })
    try {
      await mcp(srv.base, `?callerSessionId=${f.delivered}`, { "user-agent": "probe-agent/1.0" })
      const id = await identityAfter(srv.base, r => claimOnly(r) === 1)
      expect(id.thisBoot.deliveredBySource).toEqual({ "probe-agent POST query": 1 })
      expect(id.thisBoot.claimOnlyBySource).toEqual({ "probe-agent POST query": 1 })
    } finally {
      await srv.stop()
    }
  })

  it("(b) records a GET that carries the claim only in the header", async () => {
    const f = fixture()
    const srv = await startServer({ registry: f.registry })
    try {
      await getMcp(srv.base, `?callerSessionId=${f.delivered}`, { "user-agent": "curl/8.4.0" })
      await getMcp(srv.base, "", { "user-agent": "curl/8.4.0", [CALLER_HEADER]: f.delivered })
      const id = await identityAfter(srv.base, r => claimOnly(r) === 2)
      expect(id.thisBoot.claimOnlyBySource).toEqual({ "curl GET query": 1, "curl GET header": 1 })
      expect(id.thisBoot.deliveredBySource).toEqual({ "curl GET query": 1, "curl GET header": 1 })
    } finally {
      await srv.stop()
    }
  })

  it("(c) records both carriers as 'both'", async () => {
    const f = fixture()
    const srv = await startServer({ registry: f.registry })
    try {
      await mcp(srv.base, `?callerSessionId=${f.delivered}`, {
        "user-agent": "probe-agent/1.0",
        [CALLER_HEADER]: f.delivered,
      })
      const id = await identityAfter(srv.base, r => claimOnly(r) === 1)
      expect(id.thisBoot.claimOnlyBySource).toEqual({ "probe-agent POST both": 1 })
      expect(id.thisBoot.deliveredBySource).toEqual({ "probe-agent POST both": 1 })
    } finally {
      await srv.stop()
    }
  })

  it("(d) reads an empty User-Agent as none", async () => {
    const f = fixture()
    const srv = await startServer({ registry: f.registry })
    try {
      await mcp(srv.base, `?callerSessionId=${f.delivered}`, { "user-agent": "" })
      const id = await identityAfter(srv.base, r => claimOnly(r) === 1)
      expect(id.thisBoot.claimOnlyBySource).toEqual({ "none POST query": 1 })
      expect(id.thisBoot.deliveredBySource).toEqual({ "none POST query": 1 })
    } finally {
      await srv.stop()
    }
  })

  it("(e) counts no verified or anonymous request, and an undelivered claim only in claimOnlyBySource", async () => {
    const f = fixture()
    const srv = await startServer({ registry: f.registry })
    try {
      const verified = await mcp(srv.base, `?callerSessionId=${f.delivered}`, {
        "user-agent": "probe-agent/1.0",
        [TOKEN_HEADER]: f.token,
      })
      expect(verified.status).toBe(200)
      await mcp(srv.base, "", { "user-agent": "probe-agent/1.0" })
      await mcp(srv.base, `?callerSessionId=${f.undelivered}`, { "user-agent": "probe-agent/1.0" })
      const id = await identityAfter(srv.base, r => claimOnly(r) === 1)
      expect(id.counters.verified).toBe(1)
      expect(id.counters.anonymous).toBe(1)
      expect(id.thisBoot.claimOnlyBySource).toEqual({ "probe-agent POST query": 1 })
      expect(id.thisBoot.deliveredBySource).toEqual({})
    } finally {
      await srv.stop()
    }
  })

  it("(f) thisBoot mirrors the live counters and leaves the top-level class counts alone", async () => {
    const f = fixture()
    const srv = await startServer({ registry: f.registry })
    try {
      await mcp(srv.base, `?callerSessionId=${f.delivered}`, { "user-agent": "probe-agent/1.0" })
      await mcp(srv.base, "", { "user-agent": "probe-agent/1.0" })
      const id = await identityAfter(srv.base, r => claimOnly(r) === 1 && r.counters.anonymous === 1)
      expect(id.thisBoot.counters).toEqual(id.counters)
      expect(id.thisBoot.claimOnlyByClass).toEqual(id.claimOnlyByClass)
      expect(id.counters).toEqual({ verified: 0, mismatch: 0, invalid_token: 0, claim_only: 1, anonymous: 1 })
      expect(id.claimOnlyByClass).toEqual({ external: 0, delivered: 1, undelivered: 0, unknown: 0 })
      expect(id.thisBoot.since).toBe(id.bootedAt)
    } finally {
      await srv.stop()
    }
  })

  it("(g) persists no claim-source key and starts the second boot at zeros", async () => {
    const firstFixture = fixture()
    const first = await startServer({
      registry: firstFixture.registry,
      observations: { path: observationsPath, flushMs: 50 },
    })
    try {
      await mcp(first.base, `?callerSessionId=${firstFixture.delivered}`, { "user-agent": "probe-agent/1.0" })
      await identityAfter(first.base, r => claimOnly(r) === 1)
    } finally {
      await first.stop()
    }

    const secondFixture = fixture()
    const second = await startServer({
      registry: secondFixture.registry,
      observations: { path: observationsPath, flushMs: 50 },
    })
    try {
      const id = await identity(second.base)
      expect(id.claimOnlyByClass.delivered).toBe(1)
      expect(id.counters.claim_only).toBe(1)
      expect(id.thisBoot.counters).toEqual({ verified: 0, mismatch: 0, invalid_token: 0, claim_only: 0, anonymous: 0 })
      expect(id.thisBoot.claimOnlyByClass).toEqual({ external: 0, delivered: 0, undelivered: 0, unknown: 0 })
      expect(id.thisBoot.claimOnlyBySource).toEqual({})
      expect(id.thisBoot.deliveredBySource).toEqual({})
      expect(id.thisBoot.since).toBe(id.bootedAt)
      expect(id.thisBoot.since).not.toBe(id.since)
    } finally {
      await second.stop()
    }

    const serialized = readFileSync(observationsPath, "utf8")
    expect(serialized).not.toContain("thisBoot")
    expect(serialized).not.toContain("claimOnlyBySource")
    expect(serialized).not.toContain("deliveredBySource")
  })

  it("(h) keeps the log prefix, appends client/verb/via, and logs a new source or combination once", async () => {
    const f = fixture()
    const srv = await startServer({ registry: f.registry })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await mcp(srv.base, `?callerSessionId=${f.delivered}`, { "user-agent": "probe-agent/1.0" })
      await mcp(srv.base, `?callerSessionId=${f.delivered}`, { "user-agent": "probe-agent/1.0" })
      await mcp(srv.base, `?callerSessionId=${f.delivered}`, { "user-agent": "second-agent/2.0" })
      await identityAfter(srv.base, r => claimOnly(r) === 3)

      const claimLines = warn.mock.calls.map(args => String(args[0])).filter(line => line.includes("claim-only caller="))
      expect(claimLines).toHaveLength(2)
      const prefix = `[identity] claim-only caller=${f.delivered} route=/mcp class=delivered`
      expect(claimLines[0]).toBe(`${prefix} client=probe-agent verb=POST via=query`)
      expect(claimLines[1]).toBe(`${prefix} client=second-agent verb=POST via=query`)

      await mcp(srv.base, `?callerSessionId=${f.undelivered}`, {
        "user-agent": "probe-agent/1.0",
        [TOKEN_HEADER]: f.token,
      })
      await mcp(srv.base, "", { "user-agent": "probe-agent/1.0", [TOKEN_HEADER]: "apst_bogus" })
      await identityAfter(srv.base, r => r.counters.mismatch === 1 && r.counters.invalid_token === 1)

      const otherLines = warn.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.includes("[identity] mismatch ") || line.includes("[identity] invalid-token "))
      expect(otherLines).toHaveLength(2)
      for (const line of otherLines) {
        expect(line).not.toContain("client=")
        expect(line).not.toContain("verb=")
        expect(line).not.toContain("via=")
      }
    } finally {
      warn.mockRestore()
      await srv.stop()
    }
  })

  it("(i) enforce still refuses a delivered claim-only request and still counts its source", async () => {
    const f = fixture()
    const srv = await startServer({ mode: "enforce", registry: f.registry })
    try {
      const r = await mcp(srv.base, `?callerSessionId=${f.delivered}`, { "user-agent": "probe-agent/1.0" })
      expect(r.status).toBe(403)
      const body = r.json as { error?: string; message?: string }
      expect(body.error).toBe("identity_unverified")
      expect(typeof body.message).toBe("string")
      expect(r.text).not.toContain(f.token)
      const id = await identityAfter(srv.base, x => claimOnly(x) === 1)
      expect(id.thisBoot.claimOnlyBySource).toEqual({ "probe-agent POST query": 1 })
      expect(id.thisBoot.deliveredBySource).toEqual({ "probe-agent POST query": 1 })
    } finally {
      await srv.stop()
    }
  })

  it("(j) bounds the source keys at 32 plus other and keeps the total", async () => {
    const f = fixture()
    const srv = await startServer({ registry: f.registry })
    try {
      for (let i = 0; i < 40; i++) {
        await mcp(srv.base, `?callerSessionId=${f.delivered}`, { "user-agent": `agent-${i}/1.0` })
      }
      const id = await identityAfter(srv.base, r => claimOnly(r) === 40)
      const sources = id.thisBoot.claimOnlyBySource
      expect(Object.keys(sources).length).toBe(33)
      expect(Object.values(sources).reduce((a, b) => a + b, 0)).toBe(40)
      expect(sources.other).toBe(8)
    } finally {
      await srv.stop()
    }
  })
})
