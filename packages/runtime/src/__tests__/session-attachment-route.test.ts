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
