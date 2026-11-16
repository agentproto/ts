/**
 * The daemon live relay (session-chat live contract T3):
 * `GET /sessions/:id/live.mjpeg` and
 * `GET|HEAD /sessions/:id/live/:streamId/replay.mp4`, against a fake Bureau
 * (an in-process HTTP server answering `/s/<token>` with a multipart body and
 * `/v/<token>` with byte ranges) and a fake imported tool. The real Bureau is
 * never called.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"

import { createSessionLiveRelay, type SessionLiveRelay } from "../session-live-relay.js"
import { startHttpServer, type RuntimeHttpServerOptions } from "../http-server.js"
import { createSessionsRegistry } from "../sessions.js"
import { createRuntimeEvents } from "../events.js"
import { mintAppLinkSessionToken, resetAppLinkSigningKeyCacheForTests } from "../app-link-token.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

const TOKEN = "live-relay-daemon-token"
const APP_ID = "@agentik/session-chat"
const LIVE_TOKEN = "LiveSecretTokenAAAAAAAAAAAAAAAAAAAA"
const REPLAY_TOKEN = "ReplaySecretTokenBBBBBBBBBBBBBBBBBB"
const PENDING_TOKEN = "PendingSecretTokenCCCCCCCCCCCCCCCCC"
const STREAM_ID = "live_abc123"
const VIDEO = Buffer.from("0123456789abcdefghij")
const MISS = { error: "no_live_stream", message: "No live browser stream for this session." }

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time")
    await sleep(10)
  }
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
  return { start() {}, stop() {}, async fireNow() {} }
}

// ---------------------------------------------------------------- fake Bureau

interface FakeBureau {
  port: number
  /** Every request path Bureau saw. */
  paths: string[]
  /** Live stream requests still open on Bureau's side. */
  openStreams: number
  /** Range headers Bureau received on `/v/`. */
  ranges: (string | undefined)[]
  /** End every `/s/` stream after this many parts (default: never). */
  partsBeforeEnd: number | undefined
  close(): Promise<void>
}

const PART = Buffer.from("jpeg-bytes")

async function startFakeBureau(): Promise<FakeBureau> {
  const state: FakeBureau = {
    port: 0,
    paths: [],
    openStreams: 0,
    ranges: [],
    partsBeforeEnd: undefined,
    close: async () => {},
  }
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? "/"
    state.paths.push(path)
    if (path === `/s/${LIVE_TOKEN}` && req.method === "GET") {
      state.openStreams += 1
      res.writeHead(200, {
        "content-type": "multipart/x-mixed-replace; boundary=bureau-live",
        "cache-control": "no-store",
        "x-bureau-secret": LIVE_TOKEN,
      })
      let sent = 0
      const writePart = (): void => {
        res.write(`--bureau-live\r\ncontent-type: image/jpeg\r\ncontent-length: ${PART.length}\r\n\r\n`)
        res.write(PART)
        res.write("\r\n")
        sent += 1
        if (state.partsBeforeEnd !== undefined && sent >= state.partsBeforeEnd) {
          clearInterval(timer)
          res.end()
        }
      }
      const timer = setInterval(writePart, 15)
      writePart()
      res.on("close", () => {
        clearInterval(timer)
        state.openStreams -= 1
      })
      return
    }
    if (path === `/v/${PENDING_TOKEN}`) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "not_found", url: `/v/${PENDING_TOKEN}` }))
      return
    }
    if (path === `/v/${REPLAY_TOKEN}` && (req.method === "GET" || req.method === "HEAD")) {
      const range = req.headers.range
      state.ranges.push(range)
      const base = { "content-type": "video/mp4", "accept-ranges": "bytes", "x-bureau-secret": REPLAY_TOKEN }
      if (range === undefined) {
        res.writeHead(200, { ...base, "content-length": VIDEO.length })
        res.end(req.method === "HEAD" ? undefined : VIDEO)
        return
      }
      const m = /^bytes=(\d+)-(\d*)$/.exec(range)
      const start = m ? Number(m[1]) : NaN
      const end = m && m[2] !== "" ? Number(m[2]) : VIDEO.length - 1
      if (!m || start >= VIDEO.length || end < start) {
        res.writeHead(416, { ...base, "content-range": `bytes */${VIDEO.length}` })
        res.end()
        return
      }
      const slice = VIDEO.subarray(start, Math.min(end, VIDEO.length - 1) + 1)
      res.writeHead(206, {
        ...base,
        "content-length": slice.length,
        "content-range": `bytes ${start}-${start + slice.length - 1}/${VIDEO.length}`,
      })
      res.end(req.method === "HEAD" ? undefined : slice)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()))
  state.port = (server.address() as AddressInfo).port
  state.close = () =>
    new Promise<void>(resolve => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return state
}

// ----------------------------------------------------------- fake imported tool

interface Call {
  alias: string
  tool: string
  args: Record<string, unknown>
  caller: string | undefined
}

type Handler = (call: Call) => unknown

const text = (value: unknown) => ({ type: "text", text: JSON.stringify(value) })

const tabList = (tabs: { targetId: string; instance?: string; openedAt: string }[]) => ({
  structuredContent: { tabs },
  content: [text({ tabs })],
})

function liveView(bureau: FakeBureau, over: { loopback?: string; replay?: string | null; streamId?: string } = {}) {
  const body = {
    streamId: over.streamId ?? STREAM_ID,
    reused: true,
    fps: 8,
    expiresAt: "2026-11-16T12:10:00Z",
    urls: {
      loopback: over.loopback ?? `http://127.0.0.1:${bureau.port}/s/${LIVE_TOKEN}`,
      ...(over.replay === null ? {} : { replay: over.replay ?? `http://127.0.0.1:${bureau.port}/v/${REPLAY_TOKEN}` }),
    },
  }
  return { structuredContent: body, content: [text(body)] }
}

const targetGone = () => ({
  isError: true,
  content: [text({ code: "browser:target_gone", message: "target no longer exists" })],
})

// --------------------------------------------------------------------- tests

describe("daemon live relay", () => {
  let dir: string | undefined
  let bureau: FakeBureau
  let logs: string[]
  let consoleSpies: ReturnType<typeof vi.spyOn>[]

  beforeEach(async () => {
    bureau = await startFakeBureau()
    logs = []
    consoleSpies = (["log", "warn", "error", "info", "debug"] as const).map(level =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
      }),
    )
  })

  afterEach(async () => {
    for (const spy of consoleSpies) spy.mockRestore()
    // Bureau's token URLs never reach a log line, whatever the test did.
    for (const line of logs) {
      expect(line).not.toContain(LIVE_TOKEN)
      expect(line).not.toContain(REPLAY_TOKEN)
      expect(line).not.toContain(PENDING_TOKEN)
      expect(line).not.toContain(`127.0.0.1:${bureau.port}`)
    }
    await bureau.close()
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
    resetAppLinkSigningKeyCacheForTests()
  })

  interface Ctx {
    base: string
    calls: Call[]
    relay: SessionLiveRelay
    linkToken: (claims: Record<string, string>) => string
  }

  async function withServer(handler: Handler, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
    dir = await mkdtemp(join(tmpdir(), "agentproto-live-relay-"))
    const keyPath = join(dir, "app_link_hmac")
    const calls: Call[] = []
    const callImportedTool = async (alias: string, tool: string, args: Record<string, unknown>, caller?: string) => {
      const call: Call = { alias, tool, args, caller }
      calls.push(call)
      return handler(call)
    }
    // Default `log` (console.warn) on purpose: the spies capture it.
    const relay = createSessionLiveRelay({ callImportedTool, resolveAlias: async () => "bureau" })
    const port = await freePort()
    const opts: RuntimeHttpServerOptions = {
      port,
      token: TOKEN,
      auth: { mode: "none" },
      mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
      sessions: createSessionsRegistry({ persist: false }),
      appLinkKeyPath: keyPath,
      appToolCallDeps: { callImportedTool },
      sessionLiveRelay: relay,
    }
    const http = await startHttpServer(opts)
    try {
      await fn({
        base: `http://127.0.0.1:${port}`,
        calls,
        relay,
        linkToken: claims =>
          mintAppLinkSessionToken({
            appId: APP_ID,
            claims: { telegramUserId: "42", ...claims },
            ttlMs: 60_000,
            keyPath,
          }).token,
      })
    } finally {
      await http.stop()
    }
  }

  const bearer = { authorization: `Bearer ${TOKEN}` }

  const oneTab: Handler = call => {
    if (call.tool === "browser_list_owned_tabs") {
      return tabList([{ targetId: "tab_1", instance: "chrome-a", openedAt: "2026-11-16T10:00:00Z" }])
    }
    if (call.tool === "browser_live_view") return liveView(bureau)
    throw new Error(`unexpected tool ${call.tool}`)
  }

  /** Every header value and the body of a response, for leak checks. */
  function assertNoSecret(res: Response, body: string): void {
    const all = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n") + "\n" + body
    expect(all).not.toContain(LIVE_TOKEN)
    expect(all).not.toContain(REPLAY_TOKEN)
    expect(all).not.toContain(PENDING_TOKEN)
    expect(all).not.toContain(`127.0.0.1:${bureau.port}`)
    expect(all).not.toContain("x-bureau-secret")
  }

  async function readSome(res: Response, minBytes: number): Promise<string> {
    const reader = res.body!.getReader()
    let out = ""
    while (out.length < minBytes) {
      const { value, done } = await reader.read()
      if (done) break
      out += Buffer.from(value).toString("latin1")
    }
    reader.releaseLock()
    return out
  }

  /** Open the relay and keep it open; returns the response and its aborter. */
  async function openLive(base: string, sessionId = "sess_a", headers: Record<string, string> = bearer) {
    const ac = new AbortController()
    const res = await fetch(`${base}/sessions/${sessionId}/live.mjpeg`, { headers, signal: ac.signal })
    return { res, abort: () => ac.abort() }
  }

  it("relays Bureau's MJPEG verbatim, called as the path id with reuse: true, and never stops the stream", async () => {
    await withServer(oneTab, async ({ base, calls }) => {
      const { res, abort } = await openLive(base)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toBe("multipart/x-mixed-replace; boundary=bureau-live")
      expect(res.headers.get("cache-control")).toBe("no-store")
      expect(res.headers.get("x-content-type-options")).toBe("nosniff")
      expect(res.headers.get("referrer-policy")).toBe("no-referrer")
      expect(res.headers.get("x-live-stream-id")).toBe(STREAM_ID)
      expect(res.headers.get("access-control-expose-headers")?.toLowerCase()).toContain("x-live-stream-id")
      const body = await readSome(res, 200)
      expect(body.startsWith(`--bureau-live\r\ncontent-type: image/jpeg\r\ncontent-length: ${PART.length}\r\n\r\n`)).toBe(true)
      assertNoSecret(res, body)
      abort()
      expect(calls).toEqual([
        { alias: "bureau", tool: "browser_list_owned_tabs", args: {}, caller: "sess_a" },
        {
          alias: "bureau",
          tool: "browser_live_view",
          args: { tabId: "tab_1", instance: "chrome-a", reuse: true, fps: 8, maxDurationSec: 600 },
          caller: "sess_a",
        },
      ])
      expect(calls.some(c => c.tool === "browser_live_stop")).toBe(false)
    })
  })

  it("ends the response when Bureau's stream ends", async () => {
    bureau.partsBeforeEnd = 3
    await withServer(oneTab, async ({ base, relay }) => {
      const res = await fetch(`${base}/sessions/sess_a/live.mjpeg`, { headers: bearer })
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body.split("--bureau-live").length - 1).toBe(3)
      await until(() => relay.activeCount() === 0)
    })
  })

  it("a client disconnect aborts the upstream request (no leaked socket) and frees the slot", async () => {
    await withServer(oneTab, async ({ base, relay, calls }) => {
      const { res, abort } = await openLive(base)
      await readSome(res, 50)
      await until(() => bureau.openStreams === 1)
      expect(relay.activeCount("sess_a")).toBe(1)
      abort()
      await until(() => bureau.openStreams === 0)
      await until(() => relay.activeCount() === 0)
      expect(calls.some(c => c.tool === "browser_live_stop")).toBe(false)
    })
  })

  it("skips a target_gone tab and relays the next newest one", async () => {
    await withServer(
      call => {
        if (call.tool === "browser_list_owned_tabs") {
          return tabList([
            { targetId: "tab_old", openedAt: "2026-11-16T09:00:00Z" },
            { targetId: "tab_new", openedAt: "2026-11-16T10:00:00Z" },
          ])
        }
        if (call.tool === "browser_live_view") return call.args.tabId === "tab_new" ? targetGone() : liveView(bureau)
        throw new Error("unexpected")
      },
      async ({ base, calls }) => {
        const { res, abort } = await openLive(base)
        expect(res.status).toBe(200)
        abort()
        expect(calls.filter(c => c.tool === "browser_live_view").map(c => c.args.tabId)).toEqual(["tab_new", "tab_old"])
      },
    )
  })

  it("reads the text JSON block when there is no structuredContent", async () => {
    await withServer(
      call => {
        if (call.tool === "browser_list_owned_tabs") return tabList([{ targetId: "t", openedAt: "2026-11-16T10:00:00Z" }])
        return { content: liveView(bureau).content }
      },
      async ({ base }) => {
        const { res, abort } = await openLive(base)
        expect(res.status).toBe(200)
        expect(res.headers.get("x-live-stream-id")).toBe(STREAM_ID)
        abort()
      },
    )
  })

  it.each([
    ["localhost", (p: number) => `http://localhost:${p}/s/${LIVE_TOKEN}`],
    ["a LAN address", (p: number) => `http://10.0.0.5:${p}/s/${LIVE_TOKEN}`],
    ["a public host", (_p: number) => `https://bureau.example.com/s/${LIVE_TOKEN}`],
    ["https on loopback", (p: number) => `https://127.0.0.1:${p}/s/${LIVE_TOKEN}`],
    ["no explicit port", (_p: number) => `http://127.0.0.1/s/${LIVE_TOKEN}`],
    ["credentials", (p: number) => `http://u:p@127.0.0.1:${p}/s/${LIVE_TOKEN}`],
    ["another path", (p: number) => `http://127.0.0.1:${p}/v/${LIVE_TOKEN}`],
    ["a query", (p: number) => `http://127.0.0.1:${p}/s/${LIVE_TOKEN}?x=1`],
    ["IPv6 loopback", (p: number) => `http://[::1]:${p}/s/${LIVE_TOKEN}`],
  ])("refuses a non-loopback urls.loopback (%s) with the uniform 404 and never fetches it", async (_label, make) => {
    await withServer(
      call => {
        if (call.tool === "browser_list_owned_tabs") return tabList([{ targetId: "t", openedAt: "2026-11-16T10:00:00Z" }])
        return liveView(bureau, { loopback: make(bureau.port) })
      },
      async ({ base, relay }) => {
        const res = await fetch(`${base}/sessions/sess_a/live.mjpeg`, { headers: bearer })
        expect(res.status).toBe(404)
        const body = await res.text()
        expect(JSON.parse(body)).toEqual(MISS)
        assertNoSecret(res, body)
        expect(bureau.paths).toEqual([])
        expect(relay.activeCount()).toBe(0)
        expect(logs.some(l => l.includes("[live-relay]") && l.includes("refused_url"))).toBe(true)
      },
    )
  })

  it.each([
    ["no tab", (() => tabList([])) as Handler, "no_tab"],
    [
      "Bureau down",
      (() => {
        throw new Error(`connect ECONNREFUSED http://127.0.0.1:1/s/${LIVE_TOKEN}`)
      }) as Handler,
      "bureau_error",
    ],
    ["a tool error on the listing", (() => targetGone()) as Handler, "bureau_error"],
    [
      "a bad live_view result",
      ((call: Call) =>
        call.tool === "browser_list_owned_tabs"
          ? tabList([{ targetId: "t", openedAt: "2026-11-16T10:00:00Z" }])
          : { content: [text({ nothing: true })] }) as Handler,
      "bad_result",
    ],
  ])("answers the uniform 404 on a miss (%s), logged with a reason", async (_label, handler, reason) => {
    await withServer(handler, async ({ base }) => {
      const res = await fetch(`${base}/sessions/sess_a/live.mjpeg`, { headers: bearer })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual(MISS)
      expect(logs.some(l => l.includes("[live-relay]") && l.includes(`(${reason})`))).toBe(true)
    })
  })

  it("answers the uniform 404 when Bureau's stream URL itself fails", async () => {
    await withServer(
      call =>
        call.tool === "browser_list_owned_tabs"
          ? tabList([{ targetId: "t", openedAt: "2026-11-16T10:00:00Z" }])
          : liveView(bureau, { loopback: `http://127.0.0.1:${bureau.port}/s/UnknownTokenDDDDDDDDDDDDDD` }),
      async ({ base }) => {
        const res = await fetch(`${base}/sessions/sess_a/live.mjpeg`, { headers: bearer })
        expect(res.status).toBe(404)
        expect(await res.json()).toEqual(MISS)
      },
    )
  })

  it("caps relayed connections at 3 per session and 12 daemon-wide (429 live_relay_busy)", async () => {
    await withServer(oneTab, async ({ base, relay }) => {
      const open: { abort: () => void }[] = []
      try {
        for (let i = 0; i < 3; i++) {
          const o = await openLive(base, "sess_a")
          expect(o.res.status).toBe(200)
          open.push(o)
        }
        const busy = await fetch(`${base}/sessions/sess_a/live.mjpeg`, { headers: bearer })
        expect(busy.status).toBe(429)
        expect(await busy.json()).toEqual({ error: "live_relay_busy" })

        for (const s of ["sess_b", "sess_c", "sess_d"]) {
          for (let i = 0; i < 3; i++) {
            const o = await openLive(base, s)
            expect(o.res.status).toBe(200)
            open.push(o)
          }
        }
        expect(relay.activeCount()).toBe(12)
        const overall = await fetch(`${base}/sessions/sess_e/live.mjpeg`, { headers: bearer })
        expect(overall.status).toBe(429)
        expect(await overall.json()).toEqual({ error: "live_relay_busy" })
      } finally {
        for (const o of open) o.abort()
      }
      await until(() => relay.activeCount() === 0)
      await until(() => bureau.openStreams === 0)
      const again = await openLive(base, "sess_a")
      expect(again.res.status).toBe(200)
      again.abort()
    })
  })

  describe("replay.mp4", () => {
    async function relayOnce(base: string, sessionId = "sess_a"): Promise<void> {
      const { res, abort } = await openLive(base, sessionId)
      expect(res.status).toBe(200)
      abort()
    }

    it("relays the kept video of a remembered stream, passing the range header through", async () => {
      await withServer(oneTab, async ({ base }) => {
        await relayOnce(base)
        const url = `${base}/sessions/sess_a/live/${STREAM_ID}/replay.mp4`

        const full = await fetch(url, { headers: bearer })
        expect(full.status).toBe(200)
        expect(full.headers.get("content-type")).toBe("video/mp4")
        expect(full.headers.get("content-length")).toBe(String(VIDEO.length))
        expect(full.headers.get("accept-ranges")).toBe("bytes")
        expect(full.headers.get("cache-control")).toBe("no-store")
        expect(full.headers.get("x-content-type-options")).toBe("nosniff")
        expect(full.headers.get("referrer-policy")).toBe("no-referrer")
        const fullBody = Buffer.from(await full.arrayBuffer())
        expect(fullBody.equals(VIDEO)).toBe(true)
        assertNoSecret(full, fullBody.toString("latin1"))

        const part = await fetch(url, { headers: { ...bearer, range: "bytes=2-5" } })
        expect(part.status).toBe(206)
        expect(part.headers.get("content-range")).toBe(`bytes 2-5/${VIDEO.length}`)
        expect(part.headers.get("content-length")).toBe("4")
        const partBody = Buffer.from(await part.arrayBuffer())
        expect(partBody.toString()).toBe("2345")
        assertNoSecret(part, partBody.toString("latin1"))

        const bad = await fetch(url, { headers: { ...bearer, range: "bytes=99-" } })
        expect(bad.status).toBe(416)
        expect(bad.headers.get("content-range")).toBe(`bytes */${VIDEO.length}`)
        assertNoSecret(bad, await bad.text())

        const head = await fetch(url, { method: "HEAD", headers: { ...bearer, range: "bytes=0-3" } })
        expect(head.status).toBe(206)
        expect(head.headers.get("content-length")).toBe("4")
        expect(head.headers.get("content-range")).toBe(`bytes 0-3/${VIDEO.length}`)

        expect(bureau.ranges).toEqual([undefined, "bytes=2-5", "bytes=99-", "bytes=0-3"])
      })
    })

    it("a Bureau 404 (still encoding) stays the uniform 404", async () => {
      await withServer(
        call =>
          call.tool === "browser_list_owned_tabs"
            ? tabList([{ targetId: "t", openedAt: "2026-11-16T10:00:00Z" }])
            : liveView(bureau, { replay: `http://127.0.0.1:${bureau.port}/v/${PENDING_TOKEN}` }),
        async ({ base }) => {
          await relayOnce(base)
          const res = await fetch(`${base}/sessions/sess_a/live/${STREAM_ID}/replay.mp4`, { headers: bearer })
          expect(res.status).toBe(404)
          const body = await res.text()
          expect(JSON.parse(body)).toEqual(MISS)
          assertNoSecret(res, body)
        },
      )
    })

    it("an unknown or other-session streamId is the uniform 404, with no upstream request", async () => {
      await withServer(oneTab, async ({ base }) => {
        await relayOnce(base, "sess_a")
        const before = bureau.paths.filter(p => p.startsWith("/v/")).length
        for (const url of [
          `${base}/sessions/sess_a/live/live_unknown/replay.mp4`,
          `${base}/sessions/sess_b/live/${STREAM_ID}/replay.mp4`,
        ]) {
          for (const method of ["GET", "HEAD"]) {
            const res = await fetch(url, { method, headers: bearer })
            expect(res.status).toBe(404)
            if (method === "GET") expect(await res.json()).toEqual(MISS)
          }
        }
        expect(bureau.paths.filter(p => p.startsWith("/v/")).length).toBe(before)
      })
    })

    it("a non-loopback replay URL is never remembered", async () => {
      await withServer(
        call =>
          call.tool === "browser_list_owned_tabs"
            ? tabList([{ targetId: "t", openedAt: "2026-11-16T10:00:00Z" }])
            : liveView(bureau, { replay: `http://10.0.0.5:${bureau.port}/v/${REPLAY_TOKEN}` }),
        async ({ base }) => {
          await relayOnce(base)
          const res = await fetch(`${base}/sessions/sess_a/live/${STREAM_ID}/replay.mp4`, { headers: bearer })
          expect(res.status).toBe(404)
          expect(bureau.paths.filter(p => p.startsWith("/v/"))).toEqual([])
        },
      )
    })

    it("remembers only the last 5 streams of a session", async () => {
      let n = 0
      await withServer(
        call => {
          if (call.tool === "browser_list_owned_tabs") return tabList([{ targetId: "t", openedAt: "2026-11-16T10:00:00Z" }])
          n += 1
          return liveView(bureau, { streamId: `live_${n}` })
        },
        async ({ base }) => {
          for (let i = 0; i < 6; i++) await relayOnce(base)
          const first = await fetch(`${base}/sessions/sess_a/live/live_1/replay.mp4`, { headers: bearer })
          expect(first.status).toBe(404)
          const last = await fetch(`${base}/sessions/sess_a/live/live_6/replay.mp4`, { headers: bearer })
          expect(last.status).toBe(200)
          await last.arrayBuffer()
        },
      )
    })
  })

  describe("gate", () => {
    it("refuses a request with no credential on both routes", async () => {
      await withServer(oneTab, async ({ base, calls }) => {
        const live = await fetch(`${base}/sessions/sess_a/live.mjpeg`)
        expect(live.status).toBe(401)
        const replay = await fetch(`${base}/sessions/sess_a/live/${STREAM_ID}/replay.mp4`, { method: "HEAD" })
        expect(replay.status).toBe(401)
        expect(calls).toEqual([])
      })
    })

    it("a link token for session A reads A's live stream and replay, never B's", async () => {
      await withServer(oneTab, async ({ base, calls, linkToken }) => {
        const link = { authorization: `Bearer ${linkToken({ sessionId: "sess_a" })}` }

        // B has a remembered stream of its own, relayed with the daemon bearer.
        const bLive = await openLive(base, "sess_b")
        expect(bLive.res.status).toBe(200)
        bLive.abort()
        const callsBefore = calls.length

        const own = await openLive(base, "sess_a", link)
        expect(own.res.status).toBe(200)
        own.abort()
        const ownReplay = await fetch(`${base}/sessions/sess_a/live/${STREAM_ID}/replay.mp4`, { headers: link })
        expect(ownReplay.status).toBe(200)
        await ownReplay.arrayBuffer()
        const ownHead = await fetch(`${base}/sessions/sess_a/live/${STREAM_ID}/replay.mp4`, { method: "HEAD", headers: link })
        expect(ownHead.status).toBe(200)

        const otherLive = await fetch(`${base}/sessions/sess_b/live.mjpeg`, { headers: link })
        expect([401, 403, 404]).toContain(otherLive.status)
        await otherLive.text()
        for (const method of ["GET", "HEAD"]) {
          const otherReplay = await fetch(`${base}/sessions/sess_b/live/${STREAM_ID}/replay.mp4`, { method, headers: link })
          expect([401, 403, 404]).toContain(otherReplay.status)
          expect(otherReplay.headers.get("content-type")).not.toBe("video/mp4")
          await otherReplay.text()
        }
        // Nothing was asked of Bureau as B after the link's own calls.
        expect(calls.slice(callsBefore).every(c => c.caller === "sess_a")).toBe(true)
      })
    })

    it("a browserSessionId claim reads that session's live routes", async () => {
      await withServer(oneTab, async ({ base, linkToken }) => {
        const link = { authorization: `Bearer ${linkToken({ browserSessionId: "sess_a" })}` }
        const own = await openLive(base, "sess_a", link)
        expect(own.res.status).toBe(200)
        own.abort()
        const other = await fetch(`${base}/sessions/sess_b/live.mjpeg`, { headers: link })
        expect([401, 403, 404]).toContain(other.status)
        await other.text()
      })
    })
  })
})
