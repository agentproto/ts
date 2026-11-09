/**
 * `GET /sessions/:id/screencast.jpg` for an id that is not a chrome-live
 * browser descriptor serves the latest Bureau recording frame of a tab owned
 * by session `:id`. Every Bureau call is made AS `:id`, through the
 * `callImportedTool` dep, so a link can only ever see its own session's tabs.
 */

import { afterEach, describe, expect, it } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"

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
  return {
    content: [
      text({ recordingId: "rec_1", index: 3, t: 1.5, frameCount: 4 }),
      { type: "image", data: bytes.toString("base64"), mimeType },
    ],
  }
}

function noImageResult() {
  return { content: [text({ recordingId: "rec_1", index: 0, t: 0, frameCount: 0 })] }
}

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

  const oneTabHandler: Handler = call =>
    call.tool === "browser_list_owned_tabs"
      ? tabList([{ targetId: "tab_1", instance: "chrome-a", openedAt: "2026-11-09T10:00:00Z" }])
      : frameResult(FRAME)

  it("serves the frame of the session's own tab to the daemon bearer, calling Bureau as the path id", async () => {
    await withServer(oneTabHandler, async ({ base, calls }) => {
      const res = await fetch(`${base}/sessions/sess_a/screencast.jpg`, { headers: bearer })
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toBe("image/jpeg")
      expect(res.headers.get("cache-control")).toBe("no-store")
      expect(Buffer.from(await res.arrayBuffer()).equals(FRAME)).toBe(true)
      expect(calls).toEqual([
        { alias: "bureau", tool: "browser_list_owned_tabs", args: {}, caller: "sess_a" },
        {
          alias: "bureau",
          tool: "browser_record_frame",
          args: { tabId: "tab_1", instance: "chrome-a" },
          caller: "sess_a",
        },
      ])
    })
  })

  it("takes the content type from the image block", async () => {
    await withServer(
      call =>
        call.tool === "browser_list_owned_tabs"
          ? tabList([{ targetId: "tab_1", openedAt: "2026-11-09T10:00:00Z" }])
          : frameResult(FRAME, "image/png"),
      async ({ base }) => {
        const res = await fetch(`${base}/sessions/sess_a/screencast.jpg`, { headers: bearer })
        expect(res.headers.get("content-type")).toBe("image/png")
      },
    )
  })

  it("a link token for sess_a reads it; the same token on sess_b is refused and Bureau is not called", async () => {
    await withServer(oneTabHandler, async ({ base, calls, linkToken }) => {
      const token = linkToken("sess_a")
      const own = await fetch(`${base}/sessions/sess_a/screencast.jpg?token=${token}`)
      expect(own.status).toBe(200)
      expect(Buffer.from(await own.arrayBuffer()).equals(FRAME)).toBe(true)
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

  it("answers the same 404 no_screencast_frame whether there is no tab, no image block, a Bureau error, or no Bureau", async () => {
    const bodies: string[] = []
    const cases: (Handler | null)[] = [
      () => tabList([]),
      call =>
        call.tool === "browser_list_owned_tabs"
          ? tabList([{ targetId: "tab_1", openedAt: "2026-11-09T10:00:00Z" }])
          : noImageResult(),
      () => {
        throw new Error("bureau down")
      },
      null,
    ]
    for (const handler of cases) {
      await withServer(handler, async ({ base }) => {
        const res = await fetch(`${base}/sessions/sess_a/screencast.jpg`, { headers: bearer })
        expect(res.status).toBe(404)
        bodies.push(await res.text())
      })
    }
    const parsed = JSON.parse(bodies[0] as string) as { error: string; message: string }
    expect(parsed.error).toBe("no_screencast_frame")
    expect(parsed.message).toBe("No frame yet: the session must call browser_screencast_start on a tab it owns.")
    expect(new Set(bodies).size).toBe(1)
  })

  it("treats a Bureau tool error result as no frame", async () => {
    await withServer(
      () => ({ isError: true, content: [text({ code: "browser:not_owner" })] }),
      async ({ base }) => {
        const res = await fetch(`${base}/sessions/sess_a/screencast.jpg`, { headers: bearer })
        expect(res.status).toBe(404)
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
        const res = await fetch(`${base}/sessions/sess_a/screencast.jpg`, { headers: bearer })
        expect(res.status).toBe(200)
        expect(Buffer.from(await res.arrayBuffer()).equals(OLD_FRAME)).toBe(true)
        expect(calls.filter(c => c.tool === "browser_record_frame").map(c => c.args)).toEqual([
          { tabId: "tab_new", instance: "chrome-b" },
          { tabId: "tab_old", instance: "chrome-a" },
        ])
      },
    )
  })

  it("asks Bureau about at most 5 tabs", async () => {
    const tabs = Array.from({ length: 8 }, (_, i) => ({
      targetId: `tab_${i}`,
      openedAt: `2026-11-09T10:0${i}:00Z`,
    }))
    await withServer(
      call => (call.tool === "browser_list_owned_tabs" ? tabList(tabs) : noImageResult()),
      async ({ base, calls }) => {
        const res = await fetch(`${base}/sessions/sess_a/screencast.jpg`, { headers: bearer })
        expect(res.status).toBe(404)
        expect(calls.filter(c => c.tool === "browser_record_frame").map(c => c.args.tabId)).toEqual([
          "tab_7",
          "tab_6",
          "tab_5",
          "tab_4",
          "tab_3",
        ])
      },
    )
  })

  it("lists tabs once for two requests inside the cache window", async () => {
    await withServer(oneTabHandler, async ({ base, calls }) => {
      for (let i = 0; i < 2; i++) {
        const res = await fetch(`${base}/sessions/sess_a/screencast.jpg`, { headers: bearer })
        expect(res.status).toBe(200)
      }
      expect(toolsOf(calls)).toEqual([
        "browser_list_owned_tabs",
        "browser_record_frame",
        "browser_record_frame",
      ])
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
        const first = await fetch(`${base}/sessions/sess_a/screencast.jpg`, { headers: bearer })
        expect(Buffer.from(await first.arrayBuffer()).equals(FRAME)).toBe(true)
        tabGone = true
        const second = await fetch(`${base}/sessions/sess_a/screencast.jpg`, { headers: bearer })
        expect(second.status).toBe(200)
        expect(Buffer.from(await second.arrayBuffer()).equals(OLD_FRAME)).toBe(true)
        expect(toolsOf(calls)).toEqual([
          "browser_list_owned_tabs",
          "browser_record_frame",
          "browser_record_frame",
          "browser_list_owned_tabs",
          "browser_record_frame",
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
