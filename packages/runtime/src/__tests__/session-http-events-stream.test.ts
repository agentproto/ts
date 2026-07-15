/**
 * Tests for `GET /sessions/:id/events/stream` (http-server.ts) — the SSE
 * live-push sibling of `GET /sessions/:id/events`, and the standalone
 * `deliverRecordsExactlyOnce` handoff it's built on.
 *
 * The handoff's whole reason to exist is a race: a record written between
 * "finished reading the file" and "subscribed to the writer" must be
 * delivered exactly once. `deliverRecordsExactlyOnce` is unit tested with a
 * fully controlled disk iterator and a fully controlled subscribe callback
 * so that race is deterministic instead of depending on real fs/network
 * timing — see the "delivers each record exactly once" test below for the
 * actual race being forced.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as os from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"

import {
  startHttpServer,
  deliverRecordsExactlyOnce,
  type AgentAdapterResolver,
} from "../http-server.js"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
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

/** Reads `data:` frames off an SSE response body until `count` have arrived
 *  or the read stream ends. Ignores `:`-prefixed keep-alive comment lines. */
async function readSseFrames(
  res: Response,
  count: number,
): Promise<Array<Record<string, unknown>>> {
  const body = res.body
  if (!body) throw new Error("response has no body")
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const frames: Array<Record<string, unknown>> = []
  let buffer = ""
  try {
    while (frames.length < count) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while (frames.length < count && (idx = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        if (chunk.startsWith("data: ")) {
          frames.push(JSON.parse(chunk.slice("data: ".length)) as Record<string, unknown>)
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return frames
}

describe("deliverRecordsExactlyOnce", () => {
  it("subscribes synchronously, before consuming any disk records", () => {
    let subscribed = false
    async function* empty(): AsyncGenerator<Record<string, unknown>> {}
    deliverRecordsExactlyOnce({
      since: 0,
      diskRecords: empty(),
      subscribe: () => {
        subscribed = true
        return () => {}
      },
      send: () => {},
    })
    expect(subscribed).toBe(true)
  })

  it("delivers each record exactly once when a live write races the disk read", async () => {
    // The disk generator yields seq 1, then blocks on `secondLineGate`
    // before yielding its own seq 2 — giving the test a window to inject
    // live records while the disk read is still in flight, exactly the
    // handoff race the route exists to close.
    let releaseSecondLine: () => void = () => {}
    const secondLineGate = new Promise<void>(resolve => {
      releaseSecondLine = resolve
    })
    async function* diskRecords(): AsyncGenerator<Record<string, unknown>> {
      yield { seq: 1, kind: "user-prompt" }
      await secondLineGate
      yield { seq: 2, kind: "text-delta" }
    }

    const sent: Array<Record<string, unknown>> = []
    // A holder object (rather than a bare `let`) sidesteps TS narrowing
    // the closure-captured variable to `never` at the call sites below.
    const live: { onRecord: ((record: Record<string, unknown>) => void) | undefined } = {
      onRecord: undefined,
    }
    let unsubscribeCalled = false

    const { unsubscribe, done } = deliverRecordsExactlyOnce({
      since: 0,
      diskRecords: diskRecords(),
      subscribe: onRecord => {
        live.onRecord = onRecord
        return () => {
          unsubscribeCalled = true
        }
      },
      send: record => {
        sent.push(record)
      },
    })

    // subscribe() already ran — no need to await anything to observe it.
    expect(live.onRecord).not.toBeUndefined()

    // Seq 2 arrives on the LIVE channel while the disk read hasn't reached
    // it yet (it's still parked behind `secondLineGate`) — this is the
    // exact write-races-subscribe overlap: the SAME record will also show
    // up via the disk read below.
    live.onRecord?.({ seq: 2, kind: "text-delta" })
    // Seq 3 only ever arrives live (never appears on disk in this test) —
    // the "write lands after the file's current EOF" case.
    live.onRecord?.({ seq: 3, kind: "turn-end" })

    // Now let the disk read proceed to discover its own copy of seq 2.
    releaseSecondLine()
    await done

    // Exactly once each, in order — no gap (seq 3, live-only) and no dupe
    // (seq 2, delivered via both channels).
    expect(sent.map(r => r.seq)).toEqual([1, 2, 3])

    unsubscribe()
    expect(unsubscribeCalled).toBe(true)
  })

  it("skips a live record already covered by `since`", async () => {
    async function* empty(): AsyncGenerator<Record<string, unknown>> {}
    const sent: Array<Record<string, unknown>> = []
    const live: { onRecord: ((record: Record<string, unknown>) => void) | undefined } = {
      onRecord: undefined,
    }

    const { done } = deliverRecordsExactlyOnce({
      since: 5,
      diskRecords: empty(),
      subscribe: onRecord => {
        live.onRecord = onRecord
        return () => {}
      },
      send: record => sent.push(record),
    })
    live.onRecord?.({ seq: 5, kind: "stale" })
    live.onRecord?.({ seq: 6, kind: "fresh" })
    await done

    expect(sent.map(r => r.seq)).toEqual([6])
  })
})

describe("GET /sessions/:id/events/stream", () => {
  const SESSION_ID = "sess_stream1"
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "session-events-stream-http-"))
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

  it("replays records after `since` as SSE data: frames", { timeout: 15_000 }, async () => {
    writeEvents([
      { kind: "user-prompt", sessionId: SESSION_ID, text: "hi" },
      { kind: "text-delta", sessionId: SESSION_ID, text: "hello" },
      { kind: "turn-end", sessionId: SESSION_ID, reason: "completed" },
    ])

    await withServer(async (port, registry) => {
      vi.spyOn(registry, "findByIdOrName").mockReturnValue({
        id: SESSION_ID,
      } as SessionDescriptor)

      const res = await fetch(
        `http://127.0.0.1:${port}/sessions/${SESSION_ID}/events/stream?since=1`,
      )
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toBe("text/event-stream")

      const frames = await readSseFrames(res, 2)
      expect(frames.map(f => f.seq)).toEqual([2, 3])
      expect(frames.map(f => f.kind)).toEqual(["text-delta", "turn-end"])
    })
  })

  it("404s with {error: 'no_transcript'} when events.jsonl doesn't exist", { timeout: 15_000 }, async () => {
    await withServer(async port => {
      const res = await fetch(
        `http://127.0.0.1:${port}/sessions/no-such-session/events/stream`,
      )
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
        `http://127.0.0.1:${port}/sessions/${SESSION_ID}/events/stream?since=nope`,
      )
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe("invalid_since")
    })
  })

  it("does not shadow plain GET /sessions/:id/events — both routes work for the same session", { timeout: 15_000 }, async () => {
    writeEvents([{ kind: "user-prompt", sessionId: SESSION_ID, text: "hi" }])

    await withServer(async (port, registry) => {
      vi.spyOn(registry, "findByIdOrName").mockReturnValue({
        id: SESSION_ID,
      } as SessionDescriptor)

      const plain = await fetch(`http://127.0.0.1:${port}/sessions/${SESSION_ID}/events`)
      expect(plain.status).toBe(200)
      const plainBody = (await plain.json()) as { events: Array<{ seq: number }> }
      expect(plainBody.events.map(e => e.seq)).toEqual([1])

      const stream = await fetch(
        `http://127.0.0.1:${port}/sessions/${SESSION_ID}/events/stream`,
      )
      expect(stream.status).toBe(200)
      expect(stream.headers.get("content-type")).toBe("text/event-stream")
      const frames = await readSseFrames(stream, 1)
      expect(frames.map(f => f.seq)).toEqual([1])
    })
  })

  it("pushes a live record to an already-connected client", { timeout: 15_000 }, async () => {
    await withServer(async (port, registry) => {
      // A controllable agent-cli session: `send()` blocks on `gate` until
      // the test releases it, so the SSE connection is established (and
      // has drained the empty backlog) well before the live write happens.
      let releaseTurn: () => void = () => {}
      const gate = new Promise<void>(resolve => {
        releaseTurn = resolve
      })
      const agent: AgentSessionLike = {
        sessionId: SESSION_ID,
        async *send() {
          await gate
          yield { kind: "text-delta", text: "live reply\n" }
          yield { kind: "turn-end", reason: "completed" }
        },
        async cancel() {},
        async close() {},
      }
      const desc = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: agent,
        adapterSlug: "fake",
      })
      // A fresh agent-cli session has no events.jsonl until its first
      // record is written — same 404-until-first-write contract /events
      // has. Seed one record directly so the file exists. Connect with
      // since=0 (the default) so the seed record itself is replayed —
      // that's the record whose `res.write()` actually flushes the SSE
      // response headers over the socket; fetch() would otherwise hang
      // waiting on headers Node never sends until the first byte does.
      const dir = join(tmp, ".agentproto", "sessions", desc.id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, "events.jsonl"),
        JSON.stringify({ seq: 1, ts: "2026-06-01T00:00:00.000Z", kind: "user-prompt", text: "seed" }) +
          "\n",
      )

      const res = await fetch(`http://127.0.0.1:${port}/sessions/${desc.id}/events/stream`)
      expect(res.status).toBe(200)

      // 5 total: the seed (replayed) + sendPrompt's own "user-prompt" record
      // for "go" + the turn's text-delta/turn-end + the turn-boundary
      // usage_snapshot recap that fires on every turn-end.
      const framesPromise = readSseFrames(res, 5)
      // Give the connection a tick to finish replaying the seed record and
      // settle into live-push mode before triggering the turn.
      await new Promise(resolve => setTimeout(resolve, 20))
      releaseTurn()
      await registry.sendPrompt(desc.id, "go")

      const frames = await framesPromise
      expect(frames.map(f => f.kind)).toEqual([
        "user-prompt",
        "user-prompt",
        "text-delta",
        "turn-end",
        "usage_snapshot",
      ])
      expect(frames.map(f => f.seq)).toEqual([1, 2, 3, 4, 5])
    })
  })
})
