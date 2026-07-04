/**
 * Tests for `GET /sessions/:id/events` (http-server.ts) — the raw
 * events.jsonl reader that lets a web panel poll structured session
 * events directly, instead of going through /export's collapsed
 * markdown/JSON transcript.
 *
 * Uses the same persistPath-isolation trick as the PR #166 transcript
 * tests: `node:os.homedir` is mocked to point at a tmp dir, and
 * events.jsonl is written directly under
 * `<tmp>/.agentproto/sessions/<id>/events.jsonl`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as os from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"

import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import { createSessionsRegistry } from "../sessions.js"
import type { SessionDescriptor } from "../sessions.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

vi.mock("node:os", async importOriginal => {
  const orig = await importOriginal<typeof import("node:os")>()
  return { ...orig, homedir: vi.fn(() => orig.homedir()) }
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

async function mcpServerFactory() {
  const { createMcpServer } = await import("@agentproto/mcp-server")
  return (await createMcpServer({ specs: [], name: "main", version: "0" })).server
}

const resolveAgentAdapter: AgentAdapterResolver = async () => ({
  async startSession() {
    throw new Error("not used in this test")
  },
  commandPreview: "mock-adapter",
})

describe("GET /sessions/:id/events", () => {
  const SESSION_ID = "sess_events1"
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "session-events-http-"))
    vi.mocked(os.homedir).mockReturnValue(tmp)
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  function writeEvents(lines: object[]): void {
    const dir = join(tmp, ".agentproto", "sessions", SESSION_ID)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "events.jsonl"),
      lines
        .map((l, i) => JSON.stringify({ seq: i + 1, ts: "2026-06-01T00:00:00.000Z", ...l }))
        .join("\n") + "\n",
    )
  }

  async function withServer(
    run: (port: number, registry: ReturnType<typeof createSessionsRegistry>) => Promise<void>,
  ): Promise<void> {
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
      resolveAgentAdapter,
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      await run(port, registry)
    } finally {
      await http.stop()
    }
  }

  it("returns events with seq > since, nextSeq, and complete=true when exhausted", async () => {
    writeEvents([
      { kind: "user-prompt", sessionId: SESSION_ID, text: "hi" },
      { kind: "text-delta", sessionId: SESSION_ID, text: "hello" },
      { kind: "turn-end", sessionId: SESSION_ID, reason: "completed" },
    ])

    await withServer(async (port, registry) => {
      vi.spyOn(registry, "findByIdOrName").mockReturnValue({
        id: SESSION_ID,
      } as SessionDescriptor)

      const res = await fetch(`http://127.0.0.1:${port}/sessions/${SESSION_ID}/events`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        sessionId: string
        events: Array<{ seq: number; kind: string }>
        nextSeq: number
        complete: boolean
      }
      expect(body.sessionId).toBe(SESSION_ID)
      expect(body.events).toHaveLength(3)
      expect(body.events.map(e => e.kind)).toEqual(["user-prompt", "text-delta", "turn-end"])
      expect(body.nextSeq).toBe(3)
      expect(body.complete).toBe(true)
    })
  })

  it("windows with since/limit for incremental polling", async () => {
    writeEvents([
      { kind: "user-prompt", sessionId: SESSION_ID, text: "1" },
      { kind: "text-delta", sessionId: SESSION_ID, text: "2" },
      { kind: "text-delta", sessionId: SESSION_ID, text: "3" },
      { kind: "text-delta", sessionId: SESSION_ID, text: "4" },
      { kind: "turn-end", sessionId: SESSION_ID, reason: "completed" },
    ])

    await withServer(async (port, registry) => {
      vi.spyOn(registry, "findByIdOrName").mockReturnValue({
        id: SESSION_ID,
      } as SessionDescriptor)

      // since=1 skips the first record; limit=2 caps the page and signals
      // there's more to fetch.
      const res = await fetch(
        `http://127.0.0.1:${port}/sessions/${SESSION_ID}/events?since=1&limit=2`,
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        events: Array<{ seq: number }>
        nextSeq: number
        complete: boolean
      }
      expect(body.events).toHaveLength(2)
      expect(body.events.map(e => e.seq)).toEqual([2, 3])
      expect(body.nextSeq).toBe(3)
      expect(body.complete).toBe(false)

      // Poll again with the returned nextSeq as the new cursor — should
      // drain the remainder and report complete.
      const res2 = await fetch(
        `http://127.0.0.1:${port}/sessions/${SESSION_ID}/events?since=${body.nextSeq}`,
      )
      const body2 = (await res2.json()) as {
        events: Array<{ seq: number }>
        nextSeq: number
        complete: boolean
      }
      expect(body2.events.map(e => e.seq)).toEqual([4, 5])
      expect(body2.complete).toBe(true)
    })
  })

  it("404s with {error: 'no_transcript'} when events.jsonl doesn't exist", async () => {
    await withServer(async port => {
      const res = await fetch(`http://127.0.0.1:${port}/sessions/no-such-session/events`)
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe("no_transcript")
    })
  })

  it("400s on a malformed since", async () => {
    writeEvents([{ kind: "user-prompt", sessionId: SESSION_ID, text: "hi" }])

    await withServer(async (port, registry) => {
      vi.spyOn(registry, "findByIdOrName").mockReturnValue({
        id: SESSION_ID,
      } as SessionDescriptor)

      const res = await fetch(
        `http://127.0.0.1:${port}/sessions/${SESSION_ID}/events?since=not-a-number`,
      )
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe("invalid_since")
    })
  })

  it("skips malformed JSONL lines instead of failing the request", async () => {
    const dir = join(tmp, ".agentproto", "sessions", SESSION_ID)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "events.jsonl"),
      [
        JSON.stringify({ seq: 1, ts: "2026-06-01T00:00:00.000Z", kind: "user-prompt", text: "hi" }),
        "not valid json {{{",
        JSON.stringify({ seq: 2, ts: "2026-06-01T00:00:00.000Z", kind: "turn-end" }),
      ].join("\n") + "\n",
    )

    await withServer(async (port, registry) => {
      vi.spyOn(registry, "findByIdOrName").mockReturnValue({
        id: SESSION_ID,
      } as SessionDescriptor)

      const res = await fetch(`http://127.0.0.1:${port}/sessions/${SESSION_ID}/events`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { events: Array<{ seq: number }> }
      expect(body.events.map(e => e.seq)).toEqual([1, 2])
    })
  })
})
