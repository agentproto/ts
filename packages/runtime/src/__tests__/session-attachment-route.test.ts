/**
 * `GET /sessions/:id/attachments/:filename` — reads back a content-addressed
 * attachment `recordPrompt` materialized from an inline image content block
 * (transcript-writer.ts's `materializeAttachment`), so a host UI can
 * re-render the thumbnail after a page reload without the durable
 * transcript ever carrying the raw base64 bytes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createSessionsRegistry } from "../sessions.js"
import { createRuntimeEvents } from "../events.js"
import {
  sessionAttachmentsDir,
  setDefaultSessionsBaseDir,
} from "../transcript-writer.js"
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
  return { start() {}, stop() {}, async fireNow() {} }
}

async function mcpServerFactory() {
  return (await createMcpServer({ specs: [], name: "main", version: "0" })).server
}

const TOKEN = "test-secret-token"

describe("GET /sessions/:id/attachments/:filename", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "session-attachment-route-"))
    setDefaultSessionsBaseDir(tmp)
  })

  afterEach(() => {
    setDefaultSessionsBaseDir(undefined)
    rmSync(tmp, { recursive: true, force: true })
  })

  it("serves the file's bytes with a content-type derived from its extension", async () => {
    const dir = sessionAttachmentsDir("sess_1")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "abc123.png"), Buffer.from("fake-png-bytes"))

    const port = await freePort()
    const http = await startHttpServer({
      port,
      token: TOKEN,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: createSessionsRegistry({ persist: false }),
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/sessions/sess_1/attachments/abc123.png`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      )
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toBe("image/png")
      expect(res.headers.get("cache-control")).toContain("immutable")
      const bytes = Buffer.from(await res.arrayBuffer())
      expect(bytes.toString()).toBe("fake-png-bytes")
    } finally {
      await http.stop()
    }
  })

  it("404s a filename that was never materialized", async () => {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      token: TOKEN,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: createSessionsRegistry({ persist: false }),
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/sessions/sess_1/attachments/nope.png`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      )
      expect(res.status).toBe(404)
    } finally {
      await http.stop()
    }
  })

  it("rejects a path-traversal filename instead of reading outside the attachments dir", async () => {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      token: TOKEN,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: createSessionsRegistry({ persist: false }),
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/sessions/sess_1/attachments/${encodeURIComponent("../../secrets.txt")}`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      )
      expect(res.status).not.toBe(200)
    } finally {
      await http.stop()
    }
  })

  it("401s without a valid token or trusted origin — same gate as /files/upload", async () => {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      token: TOKEN,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: createSessionsRegistry({ persist: false }),
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/sessions/sess_1/attachments/abc123.png`,
      )
      expect(res.status).toBe(401)
    } finally {
      await http.stop()
    }
  })
})

/**
 * session-chat served by the daemon itself (`http://127.0.0.1:<port>/apps/…`)
 * re-renders a cold-loaded image with a same-origin GET. Browsers send no
 * `Origin` on that request and loopback has no bearer, so before the
 * `sameOriginAppUiRead` gate branch the thumbnail came back 401.
 */
describe("GET /sessions/:id/attachments/:filename from a daemon-served page", () => {
  let tmp: string
  let port: number
  let http: Awaited<ReturnType<typeof startHttpServer>>

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "session-attachment-same-origin-"))
    setDefaultSessionsBaseDir(tmp)
    const dir = sessionAttachmentsDir("sess_1")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "abc123.png"), Buffer.from("fake-png-bytes"))
    port = await freePort()
    http = await startHttpServer({
      port,
      token: TOKEN,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: createSessionsRegistry({ persist: false }),
      meta: { workspace: process.cwd(), registered: [] },
    })
  })

  afterEach(async () => {
    await http.stop()
    setDefaultSessionsBaseDir(undefined)
    rmSync(tmp, { recursive: true, force: true })
  })

  const get = (headers: Record<string, string>, method = "GET") =>
    fetch(`http://127.0.0.1:${port}/sessions/sess_1/attachments/abc123.png`, {
      method,
      headers,
    })

  it("serves an app UI page's same-origin read (no Origin, no bearer)", async () => {
    const res = await get({
      "sec-fetch-site": "same-origin",
      referer: `http://127.0.0.1:${port}/apps/@agentik/session-chat/ui?session=sess_1`,
    })
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("fake-png-bytes")
  })

  it("refuses a same-origin read from an agent-made artifact page", async () => {
    const res = await get({
      "sec-fetch-site": "same-origin",
      referer: `http://127.0.0.1:${port}/sessions/sess_2/artifacts/page/raw/apps/x.html`,
    })
    expect(res.status).toBe(401)
  })

  it("refuses a cross-site request even with an app UI Referer", async () => {
    const res = await get({
      "sec-fetch-site": "cross-site",
      referer: `http://127.0.0.1:${port}/apps/@agentik/session-chat/ui`,
    })
    expect(res.status).toBe(401)
  })

  it("refuses an app UI Referer from another host", async () => {
    const res = await get({
      "sec-fetch-site": "same-origin",
      referer: "http://evil.example/apps/@agentik/session-chat/ui",
    })
    expect(res.status).toBe(401)
  })

  it("refuses a same-origin read with no Referer", async () => {
    const res = await get({ "sec-fetch-site": "same-origin" })
    expect(res.status).toBe(401)
  })
})
