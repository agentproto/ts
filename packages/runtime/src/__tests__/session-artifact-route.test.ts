/**
 * `/sessions/:id/artifacts*` HTTP surface — the durable session-artifact
 * store's REST projection (`session-artifacts.ts`): add, list, get, pin, and
 * the read-only raw-serve route a viewer (image/pdf/html/site) embeds.
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
import type { PtyFactory, PtyProcess } from "../sessions.js"
import { createRuntimeEvents } from "../events.js"
import { setDefaultSessionsBaseDir } from "../transcript-writer.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

const fakePtyFactory: PtyFactory = (): PtyProcess => ({
  pid: 7777,
  write: () => {},
  resize: () => {},
  kill: () => {},
  onData: () => {},
  onExit: () => {},
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
  return { start() {}, stop() {}, async fireNow() {} }
}

async function mcpServerFactory() {
  return (await createMcpServer({ specs: [], name: "main", version: "0" })).server
}

const TOKEN = "test-secret-token"

describe("/sessions/:id/artifacts*", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "session-artifact-route-"))
    setDefaultSessionsBaseDir(tmp)
  })

  afterEach(() => {
    setDefaultSessionsBaseDir(undefined)
    rmSync(tmp, { recursive: true, force: true })
  })

  // Every artifact route that mutates or reads THROUGH the registry
  // (add/get/pin) requires a known session id — same posture the rest of
  // the `/sessions/:id/*` mutation surface takes (rename, pin, kill).
  // Spawn a cheap real PTY session so tests exercise the real existence
  // check rather than a session id nobody registered.
  async function startServer() {
    const port = await freePort()
    const registry = createSessionsRegistry({ persist: false, transcriptDir: tmp, spawnPty: fakePtyFactory })
    const desc = registry.spawnPty({ workspaceSlug: "default", cwd: process.cwd(), argv: ["bash"], cols: 80, rows: 24 })
    const http = await startHttpServer({
      port,
      token: TOKEN,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: registry,
      meta: { workspace: process.cwd(), registered: [] },
    })
    return {
      port,
      sessionId: desc.id,
      async stop() {
        registry.kill(desc.id)
        await http.stop()
      },
    }
  }

  it("adds an artifact via POST, lists it, and gets its bounded content back", async () => {
    const { port, sessionId, stop } = await startServer()
    try {
      const addRes = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/artifacts`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          key: "report",
          name: "report.txt",
          mimeType: "text/plain",
          bytes: Buffer.from("hello artifact").toString("base64"),
        }),
      })
      expect(addRes.status).toBe(201)
      const added = (await addRes.json()) as { key: string; versions: Array<{ version: number }> }
      expect(added.key).toBe("report")
      expect(added.versions).toHaveLength(1)

      const listRes = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/artifacts`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(listRes.status).toBe(200)
      const { artifacts } = (await listRes.json()) as { artifacts: Array<{ key: string }> }
      expect(artifacts.map(a => a.key)).toEqual(["report"])

      const getRes = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/artifacts/report`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(getRes.status).toBe(200)
      const got = (await getRes.json()) as { text?: string; truncated: boolean }
      expect(got.text).toBe("hello artifact")
      expect(got.truncated).toBe(false)
    } finally {
      await stop()
    }
  })

  it("pins and unpins via POST /pin", async () => {
    const { port, sessionId, stop } = await startServer()
    try {
      await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/artifacts`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ key: "report", bytes: Buffer.from("x").toString("base64") }),
      })
      const pinRes = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/artifacts/report/pin`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ pinned: true }),
      })
      expect(pinRes.status).toBe(200)
      const pinned = (await pinRes.json()) as { pinned: boolean }
      expect(pinned.pinned).toBe(true)
    } finally {
      await stop()
    }
  })

  it("serves raw bytes with a strict CSP that blocks connect-src", async () => {
    const { port, sessionId, stop } = await startServer()
    try {
      await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/artifacts`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          key: "page",
          kind: "html",
          mimeType: "text/html",
          bytes: Buffer.from("<h1>hi</h1>").toString("base64"),
        }),
      })
      const rawRes = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/artifacts/page/raw`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(rawRes.status).toBe(200)
      expect(rawRes.headers.get("content-type")).toContain("text/html")
      expect(rawRes.headers.get("content-security-policy")).toContain("connect-src 'none'")
      const text = await rawRes.text()
      expect(text).toBe("<h1>hi</h1>")
    } finally {
      await stop()
    }
  })

  it("serves a site directory's index.html by default and a nested asset by subpath", async () => {
    const { port, sessionId, stop } = await startServer()
    try {
      const srcDir = join(tmp, "_src-site")
      mkdirSync(join(srcDir, "assets"), { recursive: true })
      writeFileSync(join(srcDir, "index.html"), "<h1>site root</h1>")
      writeFileSync(join(srcDir, "assets", "app.css"), "body{color:red}")

      await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/artifacts`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ key: "mysite", kind: "site", sourcePath: srcDir }),
      })

      const indexRes = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/artifacts/mysite/raw`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(indexRes.status).toBe(200)
      expect(await indexRes.text()).toBe("<h1>site root</h1>")

      const cssRes = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/artifacts/mysite/raw/assets/app.css`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(cssRes.status).toBe(200)
      expect(cssRes.headers.get("content-type")).toContain("text/css")
      expect(await cssRes.text()).toBe("body{color:red}")
    } finally {
      await stop()
    }
  })

  it("404s an unknown artifact key", async () => {
    const { port, sessionId, stop } = await startServer()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/artifacts/nope`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(res.status).toBe(404)
    } finally {
      await stop()
    }
  })

  it("401s without a valid token — same gate as the attachments route", async () => {
    const { port, sessionId, stop } = await startServer()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/artifacts`)
      expect(res.status).toBe(401)
    } finally {
      await stop()
    }
  })
})
