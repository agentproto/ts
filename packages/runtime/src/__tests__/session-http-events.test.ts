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
import { createServer, request as httpRequest } from "node:http"
import { brotliDecompressSync, gunzipSync } from "node:zlib"
import { AddressInfo } from "node:net"

import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import { createTranscriptWriter } from "../transcript-writer.js"
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

  it("returns events with seq > since, nextSeq, and complete=true when exhausted", { timeout: 15_000 }, async () => {
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

  it("windows with since/limit for incremental polling", { timeout: 15_000 }, async () => {
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

  it("404s with {error: 'no_transcript'} when events.jsonl doesn't exist", { timeout: 15_000 }, async () => {
    await withServer(async port => {
      const res = await fetch(`http://127.0.0.1:${port}/sessions/no-such-session/events`)
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe("no_transcript")
    })
  })

  it("400s on a malformed since", { timeout: 15_000 }, async () => {
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

  it("keeps the since cursor correct across a writer restart (no seq collision)", { timeout: 15_000 }, async () => {
    // Drive the REAL writer through a simulated daemon restart: a fresh
    // writer instance must continue seq from disk, so a client that polled
    // up to the pre-restart cursor drains exactly the post-restart tail.
    // homedir() is mocked to tmp, so the default baseDir lands under the same
    // path the HTTP endpoint reads via sessionEventsPath(id).
    const writerA = createTranscriptWriter()
    writerA.recordPrompt(SESSION_ID, "first turn")
    writerA.recordEvent(SESSION_ID, { kind: "text-delta", text: "reply one\n" })
    writerA.recordEvent(SESSION_ID, { kind: "turn-end", reason: "completed" })
    await writerA.close(SESSION_ID)

    const writerB = createTranscriptWriter()
    writerB.recordPrompt(SESSION_ID, "second turn")
    writerB.recordEvent(SESSION_ID, { kind: "text-delta", text: "reply two\n" })
    writerB.recordEvent(SESSION_ID, { kind: "turn-end", reason: "completed" })
    await writerB.close(SESSION_ID)

    await withServer(async (port, registry) => {
      vi.spyOn(registry, "findByIdOrName").mockReturnValue({
        id: SESSION_ID,
      } as SessionDescriptor)

      // Full drain — seq must be strictly increasing with no repeats.
      const res = await fetch(`http://127.0.0.1:${port}/sessions/${SESSION_ID}/events`)
      const body = (await res.json()) as { events: Array<{ seq: number }>; nextSeq: number }
      const seqs = body.events.map(e => e.seq)
      expect(seqs).toEqual([1, 2, 3, 4, 5, 6])
      expect(body.nextSeq).toBe(6)

      // A client that had already consumed the pre-restart turn (through
      // seq 3) polls again and gets ONLY the post-restart turn — this is the
      // behaviour the seq-collision bug used to break.
      const res2 = await fetch(
        `http://127.0.0.1:${port}/sessions/${SESSION_ID}/events?since=3`,
      )
      const body2 = (await res2.json()) as {
        events: Array<{ seq: number; kind: string }>
        nextSeq: number
        complete: boolean
      }
      expect(body2.events.map(e => e.seq)).toEqual([4, 5, 6])
      expect(body2.events[0]).toMatchObject({ kind: "user-prompt" })
      expect(body2.nextSeq).toBe(6)
      expect(body2.complete).toBe(true)
    })
  })

  function rawGet(
    port: number,
    path: string,
    acceptEncoding?: string,
  ): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path,
          headers: acceptEncoding ? { "accept-encoding": acceptEncoding } : {},
        },
        res => {
          const chunks: Buffer[] = []
          res.on("data", (c: Buffer) => chunks.push(c))
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
          )
          res.on("error", reject)
        },
      )
      req.on("error", reject)
      req.end()
    })
  }

  it("compresses the page per accept-encoding (br > gzip > identity)", { timeout: 15_000 }, async () => {
    writeEvents(
      Array.from({ length: 200 }, (_, i) => ({ kind: "text-delta", sessionId: SESSION_ID, text: `chunk ${i} `.repeat(4) })),
    )

    await withServer(async (port, registry) => {
      vi.spyOn(registry, "findByIdOrName").mockReturnValue({
        id: SESSION_ID,
      } as SessionDescriptor)
      const path = `/sessions/${SESSION_ID}/events?since=10&limit=150`

      const plain = await rawGet(port, path)
      expect(plain.status).toBe(200)
      expect(plain.headers["content-encoding"]).toBeUndefined()
      expect(String(plain.headers.vary)).toMatch(/accept-encoding/i)
      const expected = JSON.parse(plain.body.toString("utf8")) as {
        events: Array<{ seq: number }>
        nextSeq: number
        complete: boolean
      }
      expect(expected.events).toHaveLength(150)
      expect(expected.events[0]?.seq).toBe(11)
      expect(expected.nextSeq).toBe(160)
      expect(expected.complete).toBe(false)

      const gz = await rawGet(port, path, "gzip, deflate")
      expect(gz.headers["content-encoding"]).toBe("gzip")
      expect(Number(gz.headers["content-length"])).toBe(gz.body.length)
      expect(gz.body.length).toBeLessThan(plain.body.length)
      expect(JSON.parse(gunzipSync(gz.body).toString("utf8"))).toEqual(expected)

      const br = await rawGet(port, path, "gzip, br")
      expect(br.headers["content-encoding"]).toBe("br")
      expect(JSON.parse(brotliDecompressSync(br.body).toString("utf8"))).toEqual(expected)

      const refused = await rawGet(port, path, "br;q=0, gzip;q=0")
      expect(refused.headers["content-encoding"]).toBeUndefined()
      expect(JSON.parse(refused.body.toString("utf8"))).toEqual(expected)

      // Tiny pages aren't worth compressing.
      const small = await rawGet(port, `/sessions/${SESSION_ID}/events?since=199`, "gzip")
      expect(small.headers["content-encoding"]).toBeUndefined()
      expect(JSON.parse(small.body.toString("utf8")).events).toHaveLength(1)
    })
  })

  it("serves an appended tail and a rewritten file correctly across calls", { timeout: 15_000 }, async () => {
    writeEvents(Array.from({ length: 1200 }, (_, i) => ({ kind: "text-delta", sessionId: SESSION_ID, text: `a${i}` })))

    await withServer(async (port, registry) => {
      vi.spyOn(registry, "findByIdOrName").mockReturnValue({
        id: SESSION_ID,
      } as SessionDescriptor)
      const get = async (since: number) =>
        (await (await fetch(`http://127.0.0.1:${port}/sessions/${SESSION_ID}/events?since=${since}`)).json()) as {
          events: Array<{ seq: number; text: string }>
          nextSeq: number
          complete: boolean
        }

      const first = await get(1195)
      expect(first.events.map(e => e.seq)).toEqual([1196, 1197, 1198, 1199, 1200])

      // Growth: the writer appends; the cached index must extend.
      writeEvents(Array.from({ length: 1300 }, (_, i) => ({ kind: "text-delta", sessionId: SESSION_ID, text: `a${i}` })))
      const grown = await get(1200)
      expect(grown.events.map(e => e.seq)).toEqual(Array.from({ length: 100 }, (_, i) => 1201 + i))
      expect(grown.complete).toBe(true)

      // Rewrite to something shorter: the stale index must not be used.
      writeEvents(Array.from({ length: 30 }, (_, i) => ({ kind: "text-delta", sessionId: SESSION_ID, text: `b${i}` })))
      const rewritten = await get(25)
      expect(rewritten.events.map(e => e.seq)).toEqual([26, 27, 28, 29, 30])
      expect(rewritten.events[0]?.text).toBe("b25")
      expect(rewritten.nextSeq).toBe(30)
    })
  })

  it("skips malformed JSONL lines instead of failing the request", { timeout: 15_000 }, async () => {
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
