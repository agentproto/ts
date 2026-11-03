/**
 * The chrome-live screencast routes (`GET /sessions/:id/screencast`,
 * `.jpg`, `.mjpg`) serve the pixels of the agent tab inside the user's own
 * Chrome. They used to ride the "read-only GETs stay open" rule of the
 * /sessions block, and CORS answers `Access-Control-Allow-Origin: *` to an
 * untrusted origin, so any web page could fetch a frame from loopback. They
 * now go through `checkSessionsToken` like a mutating route: bearer header,
 * `?token=`, an allowlisted Origin, or a widget embed token.
 */

import { describe, it, expect } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createSessionsRegistry } from "../sessions.js"
import { createRuntimeEvents } from "../events.js"
import { forgetLiveBrowserInstance, setLiveBrowserInstance } from "../browser-tools.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

const TOKEN = "screencast-test-token"
const FRAME_BYTES = Buffer.from("fake-jpeg-frame")

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

async function withChromeLiveSession(
  run: (ctx: { port: number; sessionId: string }) => Promise<void>,
): Promise<void> {
  const port = await freePort()
  const sessions = createSessionsRegistry({ persist: false })
  const desc = sessions.registerBrowser({
    adapterId: "chrome-live",
    port: 9222,
    baseUrl: "http://127.0.0.1:9222",
    wasAlreadyRunning: true,
    stop: async () => {},
  })
  setLiveBrowserInstance(desc.id, {
    screencastFrame: async () => ({
      data: FRAME_BYTES.toString("base64"),
      format: "jpeg",
      index: 0,
    }),
  } as unknown as Parameters<typeof setLiveBrowserInstance>[1])
  const http = await startHttpServer({
    port,
    token: TOKEN,
    auth: { mode: "none" },
    mcpServerFactory: async () =>
      (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    sessions,
    meta: { workspace: process.cwd(), registered: [] },
  })
  try {
    await run({ port, sessionId: desc.id })
  } finally {
    forgetLiveBrowserInstance(desc.id)
    await http.stop()
  }
}

describe("chrome-live screencast routes: per-boot token gate", () => {
  it("refuses a latest-frame read with no credential", async () => {
    await withChromeLiveSession(async ({ port, sessionId }) => {
      const res = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/screencast.jpg`)
      expect(res.status).toBe(401)
      const body = (await res.json()) as { error?: string }
      expect(body.error).toBe("sessions_unauthorized")
    })
  })

  it("refuses a cross-origin page that is not on the allowlist", async () => {
    await withChromeLiveSession(async ({ port, sessionId }) => {
      const res = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/screencast.jpg`, {
        headers: { origin: "https://evil.example" },
      })
      expect(res.status).toBe(401)
    })
  })

  it("refuses the HTML viewer and the MJPEG stream with no credential", async () => {
    await withChromeLiveSession(async ({ port, sessionId }) => {
      const page = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/screencast`)
      expect(page.status).toBe(401)
      const stream = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/screencast.mjpg`)
      expect(stream.status).toBe(401)
    })
  })

  it("serves the latest frame to a bearer caller", async () => {
    await withChromeLiveSession(async ({ port, sessionId }) => {
      const res = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/screencast.jpg`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toBe("image/jpeg")
      expect(Buffer.from(await res.arrayBuffer()).equals(FRAME_BYTES)).toBe(true)
    })
  })

  it("serves the latest frame to an allowlisted Origin", async () => {
    await withChromeLiveSession(async ({ port, sessionId }) => {
      const res = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/screencast.jpg`, {
        headers: { origin: "http://localhost:3041" },
      })
      expect(res.status).toBe(200)
    })
  })

  it("serves the viewer on ?token= and carries the token onto the stream url", async () => {
    await withChromeLiveSession(async ({ port, sessionId }) => {
      const res = await fetch(
        `http://127.0.0.1:${port}/sessions/${sessionId}/screencast?token=${TOKEN}`,
      )
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain(`src="/sessions/${sessionId}/screencast.mjpg?token=${TOKEN}"`)
    })
  })
})
