/**
 * GET /apps/:appId/external-blob — binary sibling of the app_external_read
 * MCP tool (app-external.ts): streams a granted `externalReadRoots` file's
 * raw bytes over HTTP instead of a tool's JSON response. Exercises the real
 * REST layer via `startHttpServer`, same harness pattern as
 * app-ui-host-http.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer, type RuntimeHttpServerOptions } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createAppRegistry, type AppRegistry } from "../app-registry.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

const APP_ID = "@test/external-blob-app"

describe("GET /apps/:appId/external-blob", () => {
  let sandboxDir: string
  let externalDir: string
  let appRegistry: AppRegistry

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "agentproto-external-blob-sandbox-"))
    externalDir = await mkdtemp(join(tmpdir(), "agentproto-external-blob-root-"))
    await writeFile(join(externalDir, "cv.pdf"), "%PDF-1.4 not really a pdf but bytes", "utf8")
    await writeFile(join(externalDir, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await writeFile(join(externalDir, "notes.txt"), "hello world", "utf8")
    await mkdir(join(externalDir, "sub"), { recursive: true })
    appRegistry = createAppRegistry()
    appRegistry.upsertApp({
      appId: APP_ID,
      dir: sandboxDir,
      agents: [],
      workflows: [],
      unvalidatedAgentTools: [],
      externalReadRoots: [externalDir],
    })
  })

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true })
    await rm(externalDir, { recursive: true, force: true })
  })

  async function withServer(
    fn: (base: string) => Promise<void>,
    extra?: Partial<RuntimeHttpServerOptions>,
  ): Promise<void> {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () =>
        (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
      appRegistry,
      ...extra,
    })
    try {
      await fn(`http://127.0.0.1:${port}`)
    } finally {
      await http.stop()
    }
  }

  it("streams a PDF's raw bytes with application/pdf content-type", async () => {
    await withServer(async base => {
      const res = await fetch(
        `${base}/apps/${APP_ID}/external-blob?root=${encodeURIComponent(externalDir)}&path=cv.pdf`,
      )
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toBe("application/pdf")
      expect(res.headers.get("content-disposition")).toBe("inline")
      const body = await res.text()
      expect(body).toContain("%PDF-1.4")
    })
  })

  it("streams a PNG's raw bytes with image/png content-type", async () => {
    await withServer(async base => {
      const res = await fetch(
        `${base}/apps/${APP_ID}/external-blob?root=${encodeURIComponent(externalDir)}&path=photo.png`,
      )
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toBe("image/png")
      const buf = Buffer.from(await res.arrayBuffer())
      expect(buf[0]).toBe(0x89)
    })
  })

  it("streams a plain text file too (no extension allowlist on this route)", async () => {
    await withServer(async base => {
      const res = await fetch(
        `${base}/apps/${APP_ID}/external-blob?root=${encodeURIComponent(externalDir)}&path=notes.txt`,
      )
      expect(res.status).toBe(200)
      expect(await res.text()).toBe("hello world")
    })
  })

  it("403s when `root` isn't an exact match to a granted entry", async () => {
    await withServer(async base => {
      const res = await fetch(
        `${base}/apps/${APP_ID}/external-blob?root=${encodeURIComponent(join(externalDir, "sub"))}&path=x`,
      )
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: string }
      expect(body.error).toContain("not granted")
    })
  })

  it("400s when `root` is missing", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/apps/${APP_ID}/external-blob?path=cv.pdf`)
      expect(res.status).toBe(400)
    })
  })

  it("400s on a path-traversal attempt", async () => {
    await withServer(async base => {
      const res = await fetch(
        `${base}/apps/${APP_ID}/external-blob?root=${encodeURIComponent(externalDir)}&path=${encodeURIComponent("../../etc/passwd")}`,
      )
      expect(res.status).toBe(400)
    })
  })

  it("400s when `path` names a directory", async () => {
    await withServer(async base => {
      const res = await fetch(
        `${base}/apps/${APP_ID}/external-blob?root=${encodeURIComponent(externalDir)}&path=sub`,
      )
      expect(res.status).toBe(400)
    })
  })

  it("404s for a missing file", async () => {
    await withServer(async base => {
      const res = await fetch(
        `${base}/apps/${APP_ID}/external-blob?root=${encodeURIComponent(externalDir)}&path=nope.pdf`,
      )
      expect(res.status).toBe(404)
    })
  })

  it("404s for an app that isn't installed", async () => {
    await withServer(async base => {
      const res = await fetch(
        `${base}/apps/@nope/nothing/external-blob?root=${encodeURIComponent(externalDir)}&path=cv.pdf`,
      )
      expect(res.status).toBe(404)
    })
  })

  it("blocks a non-allowlisted browser origin's drive-by", async () => {
    await withServer(async base => {
      const res = await fetch(
        `${base}/apps/${APP_ID}/external-blob?root=${encodeURIComponent(externalDir)}&path=cv.pdf`,
        { headers: { origin: "http://evil.example" } },
      )
      expect(res.status).toBe(403)
    })
  })

  it("rejects POST (GET-only)", async () => {
    await withServer(async base => {
      const res = await fetch(
        `${base}/apps/${APP_ID}/external-blob?root=${encodeURIComponent(externalDir)}&path=cv.pdf`,
        { method: "POST" },
      )
      expect(res.status).not.toBe(200)
    })
  })
})

// ── tiny stubs (mirror app-ui-host-http.test.ts) ──

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
