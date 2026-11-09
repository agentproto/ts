/**
 * `GET /sessions/:id/screencast.jpg` for an id that is not a chrome-live
 * browser descriptor serves a Bureau `browser_screenshot` of the newest open
 * tab owned by session `:id` (no recording needed). Every Bureau call is made
 * AS `:id`, through the `callImportedTool` dep, so a link can only ever see its
 * own session's tabs.
 */

import { afterEach, describe, expect, it } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"

import { createSessionScreencastReader } from "../session-screencast.js"
import { startHttpServer, type RuntimeHttpServerOptions } from "../http-server.js"
import { createSessionsRegistry } from "../sessions.js"
import { createRuntimeEvents } from "../events.js"
import { mintAppLinkSessionToken, resetAppLinkSigningKeyCacheForTests } from "../app-link-token.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

const TOKEN = "session-screencast-token"
const APP_ID = "@agentik/session-chat"
const FRAME = Buffer.from("bureau-jpeg-frame")
const OLD_FRAME = Buffer.from("older-tab-frame")

interface Call {
  alias: string
  tool: string
  args: Record<string, unknown>
  caller: string | undefined
}

type Handler = (call: Call) => unknown

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

const text = (value: unknown) => ({ type: "text", text: JSON.stringify(value) })

function tabList(tabs: { targetId: string; instance?: string; openedAt: string }[]) {
  return { content: [text({ owner: "sess_a", tabs })] }
}

function frameResult(bytes: Buffer, mimeType = "image/jpeg") {
  return { content: [{ type: "image", data: bytes.toString("base64"), mimeType }] }
}

/** The real `browser_screenshot` payload of a raw imported-tool call: no `image` block. */
const shotJson = (bytes: Buffer, format = "jpeg") => ({
  base64: bytes.toString("base64"),
  format,
  width: 1280,
  height: 720,
})
const shotAsText = (bytes: Buffer, format?: string) => ({ content: [text(shotJson(bytes, format))] })
const shotAsStructured = (bytes: Buffer, format?: string) => ({ structuredContent: shotJson(bytes, format) })
const shotAsBoth = (bytes: Buffer, format?: string) => ({
  content: [text(shotJson(bytes, format))],
  structuredContent: shotJson(bytes, format),
})

function noImageResult() {
  return { content: [text({ note: "no image" })] }
}

function recordingNotFound() {
  return {
    isError: true,
    content: [text({ code: "browser:recording_not_found", message: "no recording on this tab" })],
  }
}

function targetGone() {
  return {
    isError: true,
    content: [text({ code: "browser:target_gone", message: 'target "tab" no longer exists' })],
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const PAST_CACHE_WINDOW_MS = 900
const NO_FRAME_MESSAGE = "No open browser tab for this session."

describe("GET /sessions/:id/screencast.jpg from Bureau", () => {
  let dir: string | undefined

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
    resetAppLinkSigningKeyCacheForTests()
  })

  async function withServer(
    handler: Handler | null,
    fn: (ctx: { base: string; calls: Call[]; linkToken: (sessionId: string) => string }) => Promise<void>,
  ): Promise<void> {
    dir = await mkdtemp(join(tmpdir(), "agentproto-session-screencast-"))
    const keyPath = join(dir, "app_link_hmac")
    const calls: Call[] = []
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
      ...(handler
        ? {
            appToolCallDeps: {
              callImportedTool: async (alias, tool, args, caller) => {
                const call: Call = { alias, tool, args, caller }
                calls.push(call)
                return handler(call)
              },
            },
          }
        : {}),
    }
    const http = await startHttpServer(opts)
    try {
      await fn({
        base: `http://127.0.0.1:${port}`,
        calls,
        linkToken: sessionId =>
          mintAppLinkSessionToken({
            appId: APP_ID,
            claims: { sessionId, telegramUserId: "42" },
            ttlMs: 60_000,
            keyPath,
          }).token,
      })
    } finally {
      await http.stop()
    }
  }

  const bearer = { authorization: `Bearer ${TOKEN}` }
  const toolsOf = (calls: Call[]) => calls.map(c => c.tool)

  /** No recording anywhere: `browser_record_frame` always answers recording_not_found. */
  const oneTabHandler: Handler = call => {
    if (call.tool === "browser_list_owned_tabs") {
      return tabList([{ targetId: "tab_1", instance: "chrome-a", openedAt: "2026-11-09T10:00:00Z" }])
    }
    if (call.tool === "browser_record_frame") return recordingNotFound()
    return frameResult(FRAME)
  }

  const get = (base: string, id = "sess_a", init?: RequestInit) =>
    fetch(`${base}/sessions/${id}/screencast.jpg`, { headers: bearer, ...init })
  const shots = (calls: Call[]) => calls.filter(c => c.tool === "browser_screenshot")

  it("serves a screenshot of the session's own tab with no recording, calling Bureau as the path id", async () => {
    await withServer(oneTabHandler, async ({ base, calls }) => {
      const res = await get(base)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toBe("image/jpeg")
      expect(res.headers.get("cache-control")).toBe("no-store")
      expect(res.headers.get("content-length")).toBe(String(FRAME.length))
      expect(Buffer.from(await res.arrayBuffer()).equals(FRAME)).toBe(true)
      expect(calls).toEqual([
        { alias: "bureau", tool: "browser_list_owned_tabs", args: {}, caller: "sess_a" },
        {
          alias: "bureau",
          tool: "browser_screenshot",
          args: { tabId: "tab_1", instance: "chrome-a", format: "jpeg", quality: 55 },
          caller: "sess_a",
        },
      ])
      expect(toolsOf(calls)).not.toContain("browser_record_frame")
    })
  })

  const realShapes: [string, (bytes: Buffer, format?: string) => unknown][] = [
    ["a text block holding the JSON", shotAsText],
    ["structuredContent only", shotAsStructured],
    ["both a text block and structuredContent", shotAsBoth],
  ]
  for (const [name, shape] of realShapes) {
    it(`serves the real browser_screenshot result given as ${name}`, async () => {
      for (const [format, mime] of [
        ["jpeg", "image/jpeg"],
        ["png", "image/png"],
        ["webp", "image/webp"],
      ] as const) {
        await withServer(
          call =>
            call.tool === "browser_list_owned_tabs"
              ? tabList([{ targetId: "tab_1", openedAt: "2026-11-09T10:00:00Z" }])
              : shape(FRAME, format),
          async ({ base }) => {
            const res = await get(base)
            expect(res.status).toBe(200)
            expect(res.headers.get("content-type")).toBe(mime)
            expect(Buffer.from(await res.arrayBuffer()).equals(FRAME)).toBe(true)
          },
        )
      }
    })
  }

  it("also reads the driver-layer field name `data` in place of `base64`", async () => {
    const asData = { data: FRAME.toString("base64"), format: "png", width: 1, height: 1 }
    for (const result of [{ structuredContent: asData }, { content: [text(asData)] }]) {
      await withServer(
        call =>
          call.tool === "browser_list_owned_tabs"
            ? tabList([{ targetId: "tab_1", openedAt: "2026-11-09T10:00:00Z" }])
            : result,
        async ({ base }) => {
          const res = await get(base)
          expect(res.status).toBe(200)
          expect(res.headers.get("content-type")).toBe("image/png")
          expect(Buffer.from(await res.arrayBuffer()).equals(FRAME)).toBe(true)
        },
      )
    }
  })

  it("takes the content type from the image block", async () => {
    await withServer(
      call =>
        call.tool === "browser_list_owned_tabs"
          ? tabList([{ targetId: "tab_1", openedAt: "2026-11-09T10:00:00Z" }])
          : frameResult(FRAME, "image/png"),
      async ({ base }) => {
        const res = await get(base)
        expect(res.headers.get("content-type")).toBe("image/png")
      },
    )
  })

  it("omits instance from the screenshot call when the tab has none", async () => {
    await withServer(
      call =>
        call.tool === "browser_list_owned_tabs"
          ? tabList([{ targetId: "tab_1", openedAt: "2026-11-09T10:00:00Z" }])
          : frameResult(FRAME),
      async ({ base, calls }) => {
        await get(base)
        expect(shots(calls).map(c => c.args)).toEqual([{ tabId: "tab_1", format: "jpeg", quality: 55 }])
      },
    )
  })

  it("serves the same bytes from the frame cache inside 800 ms and captures again after it", async () => {
    let n = 0
    await withServer(
      call => {
        if (call.tool === "browser_list_owned_tabs") {
          return tabList([{ targetId: "tab_1", openedAt: "2026-11-09T10:00:00Z" }])
        }
        n += 1
        return frameResult(Buffer.from(`frame-${n}`))
      },
      async ({ base, calls }) => {
        const a = await get(base)
        const b = await get(base)
        expect(await a.text()).toBe("frame-1")
        expect(await b.text()).toBe("frame-1")
        expect(shots(calls)).toHaveLength(1)
        await sleep(PAST_CACHE_WINDOW_MS)
        const c = await get(base)
        expect(await c.text()).toBe("frame-2")
        expect(shots(calls)).toHaveLength(2)
        expect(calls.filter(x => x.tool === "browser_list_owned_tabs")).toHaveLength(1)
      },
    )
  })

  it("makes one screenshot call for 5 parallel requests of one session", async () => {
    await withServer(
      async call => {
        if (call.tool === "browser_list_owned_tabs") {
          return tabList([{ targetId: "tab_1", openedAt: "2026-11-09T10:00:00Z" }])
        }
        await sleep(150)
        return frameResult(FRAME)
      },
      async ({ base, calls }) => {
        const responses = await Promise.all(Array.from({ length: 5 }, () => get(base)))
        for (const res of responses) {
          expect(res.status).toBe(200)
          expect(Buffer.from(await res.arrayBuffer()).equals(FRAME)).toBe(true)
        }
        expect(shots(calls)).toHaveLength(1)
      },
    )
  })

  it("never shares a frame between two sessions", async () => {
    await withServer(
      call => {
        if (call.tool === "browser_list_owned_tabs") {
          return tabList([{ targetId: `tab_of_${call.caller}`, openedAt: "2026-11-09T10:00:00Z" }])
        }
        return frameResult(Buffer.from(`frame-of-${call.caller}`))
      },
      async ({ base, calls }) => {
        const [a, b] = await Promise.all([get(base, "sess_a"), get(base, "sess_b")])
        expect(await a.text()).toBe("frame-of-sess_a")
        expect(await b.text()).toBe("frame-of-sess_b")
        const again = await get(base, "sess_b")
        expect(await again.text()).toBe("frame-of-sess_b")
        expect(shots(calls).map(c => [c.caller, c.args.tabId])).toEqual([
          ["sess_a", "tab_of_sess_a"],
          ["sess_b", "tab_of_sess_b"],
        ])
      },
    )
  })

  it("keeps at most 2 screenshot captures in flight daemon-wide", async () => {
    let inFlight = 0
    let peak = 0
    await withServer(
      async call => {
        if (call.tool === "browser_list_owned_tabs") {
          return tabList([{ targetId: `tab_of_${call.caller}`, openedAt: "2026-11-09T10:00:00Z" }])
        }
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await sleep(120)
        inFlight -= 1
        return frameResult(Buffer.from(`frame-of-${call.caller}`))
      },
      async ({ base, calls }) => {
        const ids = ["sess_1", "sess_2", "sess_3", "sess_4", "sess_5"]
        const responses = await Promise.all(ids.map(id => get(base, id)))
        for (const [i, res] of responses.entries()) {
          expect(res.status).toBe(200)
          expect(await res.text()).toBe(`frame-of-${ids[i]}`)
        }
        expect(shots(calls)).toHaveLength(5)
        expect(peak).toBe(2)
      },
    )
  })

  it("a link token for sess_a reads it; the same token on sess_b is refused and Bureau is not called", async () => {
    await withServer(oneTabHandler, async ({ base, calls, linkToken }) => {
      const token = linkToken("sess_a")
      const own = await fetch(`${base}/sessions/sess_a/screencast.jpg?token=${token}`)
      expect(own.status).toBe(200)
      expect(Buffer.from(await own.arrayBuffer()).equals(FRAME)).toBe(true)
      expect(shots(calls)).toHaveLength(1)
      expect(calls.every(c => c.caller === "sess_a")).toBe(true)
      const before = calls.length

      const other = await fetch(`${base}/sessions/sess_b/screencast.jpg?token=${token}`)
      expect(other.status).toBe(401)
      const otherHeader = await fetch(`${base}/sessions/sess_b/screencast.jpg`, {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(otherHeader.status).toBe(401)
      expect(calls).toHaveLength(before)
    })
  })

  it("answers the same 404 no_screencast_frame whether there is no tab, only tool errors, a throw, or no Bureau", async () => {
    const bodies: string[] = []
    const cases: (Handler | null)[] = [
      () => tabList([]),
      call =>
        call.tool === "browser_list_owned_tabs"
          ? tabList([{ targetId: "tab_1", openedAt: "2026-11-09T10:00:00Z" }])
          : targetGone(),
      call =>
        call.tool === "browser_list_owned_tabs"
          ? tabList([{ targetId: "tab_1", openedAt: "2026-11-09T10:00:00Z" }])
          : noImageResult(),
      call =>
        call.tool === "browser_list_owned_tabs"
          ? tabList([{ targetId: "tab_1", openedAt: "2026-11-09T10:00:00Z" }])
          : { content: [text({ ...shotJson(FRAME), base64: "" })] },
      () => {
        throw new Error("bureau down")
      },
      null,
    ]
    for (const handler of cases) {
      await withServer(handler, async ({ base }) => {
        const res = await get(base)
        expect(res.status).toBe(404)
        bodies.push(await res.text())
      })
    }
    const parsed = JSON.parse(bodies[0] as string) as { error: string; message: string }
    expect(parsed.error).toBe("no_screencast_frame")
    expect(parsed.message).toBe(NO_FRAME_MESSAGE)
    expect(new Set(bodies).size).toBe(1)
  })

  it("treats a Bureau tool error result as no frame", async () => {
    await withServer(
      () => ({ isError: true, content: [text({ code: "browser:not_owner" })] }),
      async ({ base }) => {
        const res = await get(base)
        expect(res.status).toBe(404)
      },
    )
  })

  it("serves the older tab when the newest answers target_gone, and re-lists tabs on the next request", async () => {
    let lists = 0
    await withServer(
      call => {
        if (call.tool === "browser_list_owned_tabs") {
          lists += 1
          return tabList([
            { targetId: "tab_old", instance: "chrome-a", openedAt: "2026-11-09T09:00:00Z" },
            { targetId: "tab_new", instance: "chrome-b", openedAt: "2026-11-09T10:00:00Z" },
          ])
        }
        return call.args.tabId === "tab_old" ? frameResult(OLD_FRAME) : targetGone()
      },
      async ({ base, calls }) => {
        const res = await get(base)
        expect(res.status).toBe(200)
        expect(Buffer.from(await res.arrayBuffer()).equals(OLD_FRAME)).toBe(true)
        expect(shots(calls).map(c => c.args.tabId)).toEqual(["tab_new", "tab_old"])
        expect(lists).toBe(1)

        await sleep(PAST_CACHE_WINDOW_MS)
        const next = await get(base)
        expect(next.status).toBe(200)
        expect(lists).toBe(2)
      },
    )
  })

  it("skips the newest tab without an image block for the older tab that has one", async () => {
    await withServer(
      call => {
        if (call.tool === "browser_list_owned_tabs") {
          return tabList([
            { targetId: "tab_old", instance: "chrome-a", openedAt: "2026-11-09T09:00:00Z" },
            { targetId: "tab_new", instance: "chrome-b", openedAt: "2026-11-09T10:00:00Z" },
          ])
        }
        return call.args.tabId === "tab_old" ? frameResult(OLD_FRAME) : noImageResult()
      },
      async ({ base, calls }) => {
        const res = await get(base)
        expect(res.status).toBe(200)
        expect(Buffer.from(await res.arrayBuffer()).equals(OLD_FRAME)).toBe(true)
        expect(shots(calls).map(c => c.args.tabId)).toEqual(["tab_new", "tab_old"])
      },
    )
  })

  it("asks Bureau about at most 5 tabs", async () => {
    const tabs = Array.from({ length: 8 }, (_, i) => ({
      targetId: `tab_${i}`,
      openedAt: `2026-11-09T10:0${i}:00Z`,
    }))
    await withServer(
      call => (call.tool === "browser_list_owned_tabs" ? tabList(tabs) : targetGone()),
      async ({ base, calls }) => {
        const res = await get(base)
        expect(res.status).toBe(404)
        expect(shots(calls).map(c => c.args.tabId)).toEqual(["tab_7", "tab_6", "tab_5", "tab_4", "tab_3"])
      },
    )
  })

  it("lists tabs once for two captures inside the tab cache window", async () => {
    await withServer(oneTabHandler, async ({ base, calls }) => {
      expect((await get(base)).status).toBe(200)
      await sleep(PAST_CACHE_WINDOW_MS)
      expect((await get(base)).status).toBe(200)
      expect(toolsOf(calls)).toEqual(["browser_list_owned_tabs", "browser_screenshot", "browser_screenshot"])
    })
  })

  it("re-lists once when a cached tab no longer yields a frame", async () => {
    let tabGone = false
    await withServer(
      call => {
        if (call.tool === "browser_list_owned_tabs") {
          return tabList([
            tabGone
              ? { targetId: "tab_2", openedAt: "2026-11-09T11:00:00Z" }
              : { targetId: "tab_1", openedAt: "2026-11-09T10:00:00Z" },
          ])
        }
        if (call.args.tabId === "tab_1" && tabGone) throw new Error("no such tab")
        return frameResult(call.args.tabId === "tab_1" ? FRAME : OLD_FRAME)
      },
      async ({ base, calls }) => {
        const first = await get(base)
        expect(Buffer.from(await first.arrayBuffer()).equals(FRAME)).toBe(true)
        tabGone = true
        await sleep(PAST_CACHE_WINDOW_MS)
        const second = await get(base)
        expect(second.status).toBe(200)
        expect(Buffer.from(await second.arrayBuffer()).equals(OLD_FRAME)).toBe(true)
        expect(toolsOf(calls)).toEqual([
          "browser_list_owned_tabs",
          "browser_screenshot",
          "browser_screenshot",
          "browser_list_owned_tabs",
          "browser_screenshot",
        ])
      },
    )
  })

  it("keeps .mjpg and the viewer at 404 for a non-chrome-live id and never calls Bureau", async () => {
    await withServer(oneTabHandler, async ({ base, calls }) => {
      for (const suffix of ["screencast.mjpg", "screencast"]) {
        const res = await fetch(`${base}/sessions/sess_a/${suffix}`, { headers: bearer })
        expect(res.status).toBe(404)
      }
      expect(calls).toHaveLength(0)
    })
  })

  it("still refuses the read without a credential", async () => {
    await withServer(oneTabHandler, async ({ base, calls }) => {
      const res = await fetch(`${base}/sessions/sess_a/screencast.jpg`)
      expect(res.status).toBe(401)
      expect(calls).toHaveLength(0)
    })
  })
})

describe("session screencast reader limits", () => {
  const tabsFor = () => tabList([{ targetId: "tab_1", openedAt: "2026-11-09T10:00:00Z" }])

  const badResults: [string, unknown][] = [
    ["an empty base64", { content: [text({ ...shotJson(FRAME), base64: "" })] }],
    ["a base64 that decodes to nothing", { structuredContent: { ...shotJson(FRAME), base64: "!!!" } }],
    ["an unknown format", { content: [text(shotJson(FRAME, "gif"))] }],
    ["a missing format", { structuredContent: { base64: FRAME.toString("base64") } }],
    ["a text block that is not JSON", { content: [{ type: "text", text: "not json at all" }] }],
    ["a JSON array", { content: [{ type: "text", text: JSON.stringify([shotJson(FRAME)]) }] }],
    ["no content at all", {}],
    ["null", null],
  ]
  for (const [name, result] of badResults) {
    it(`logs bad_result, not bureau_error, and misses for ${name}`, async () => {
      const lines: string[] = []
      const reader = createSessionScreencastReader({
        log: line => lines.push(line),
        callImportedTool: async (_alias, tool) => (tool === "browser_list_owned_tabs" ? tabsFor() : result),
      })
      expect(await reader.read("sess_1")).toEqual({ ok: false, reason: "bad_result" })
      expect(lines).toEqual(['[screencast] session "sess_1": no frame (bad_result)'])
      expect(lines.join("\n")).not.toContain(FRAME.toString("base64"))
    })
  }

  it("keeps bureau_error for a thrown call and a tool error result", async () => {
    for (const answer of [
      () => {
        throw new Error("bureau down")
      },
      () => targetGone(),
    ]) {
      const lines: string[] = []
      const reader = createSessionScreencastReader({
        log: line => lines.push(line),
        callImportedTool: async (_alias, tool) => (tool === "browser_list_owned_tabs" ? tabsFor() : answer()),
      })
      expect(await reader.read("sess_1")).toEqual({ ok: false, reason: "bureau_error" })
      expect(lines).toEqual(['[screencast] session "sess_1": no frame (bureau_error)'])
    }
  })

  it("logs one bad_result line per 30 s per session and never the base64", async () => {
    let t = 1_000_000
    const lines: string[] = []
    const reader = createSessionScreencastReader({
      now: () => t,
      log: line => lines.push(line),
      callImportedTool: async (_alias, tool) =>
        tool === "browser_list_owned_tabs" ? tabsFor() : { content: [text({ ...shotJson(FRAME), format: "bmp" })] },
    })
    await reader.read("sess_1")
    t += 1_000
    await reader.read("sess_1")
    expect(lines).toEqual(['[screencast] session "sess_1": no frame (bad_result)'])
    t += 30_000
    await reader.read("sess_1")
    expect(lines).toHaveLength(2)
    expect(lines.join("\n")).not.toContain(FRAME.toString("base64"))
  })

  it("answers a miss for a capture that waits longer than the queue limit, without calling Bureau for it", async () => {
    const release: (() => void)[] = []
    const seen: (string | undefined)[] = []
    const reader = createSessionScreencastReader({
      queueWaitMs: 50,
      log: () => {},
      callImportedTool: async (_alias, tool, _args, caller) => {
        if (tool === "browser_list_owned_tabs") return tabsFor()
        seen.push(caller)
        await new Promise<void>(resolve => release.push(resolve))
        return frameResult(FRAME)
      },
    })
    const a = reader.read("sess_1")
    const b = reader.read("sess_2")
    await sleep(20)
    const c = await reader.read("sess_3")
    expect(c).toEqual({ ok: false, reason: "bureau_error" })
    release.forEach(r => r())
    expect((await a).ok).toBe(true)
    expect((await b).ok).toBe(true)
    expect(seen.sort()).toEqual(["sess_1", "sess_2"])
  })

  it("serves a frame for 800 ms and keeps at most 50 sessions in the frame cache", async () => {
    let t = 1_000_000
    let shotsMade = 0
    const reader = createSessionScreencastReader({
      now: () => t,
      log: () => {},
      callImportedTool: async (_alias, tool) => {
        if (tool === "browser_list_owned_tabs") return tabsFor()
        shotsMade += 1
        return frameResult(FRAME)
      },
    })
    await reader.read("sess_0")
    t += 799
    await reader.read("sess_0")
    expect(shotsMade).toBe(1)
    t += 1
    await reader.read("sess_0")
    expect(shotsMade).toBe(2)
    for (let i = 1; i <= 50; i++) await reader.read(`sess_${i}`)
    expect(shotsMade).toBe(52)
    await reader.read("sess_0")
    expect(shotsMade).toBe(53)
    await reader.read("sess_50")
    expect(shotsMade).toBe(53)
  })
})
