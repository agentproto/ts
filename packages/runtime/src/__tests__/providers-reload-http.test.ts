/**
 * `POST /providers/reload` — the hot reload `agentproto auth provider set`
 * calls after storing a key. It re-runs `injectProviderKeysIntoEnv` in the
 * daemon process (explicit env still wins), so a new provider key becomes
 * visible to new spawns without restarting the daemon and killing sessions.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

const PROVIDER = "reloadprobe"
const ENV_NAME = "RELOADPROBE_API_KEY"

describe("POST /providers/reload", () => {
  let realHome: string | undefined
  let fakeHome: string

  beforeEach(() => {
    realHome = process.env.HOME
    fakeHome = mkdtempSync(join(tmpdir(), "agentproto-providers-reload-"))
    process.env.HOME = fakeHome
    delete process.env[ENV_NAME]
    mkdirSync(join(fakeHome, ".agentproto"), { recursive: true })
    writeFileSync(
      join(fakeHome, ".agentproto", "providers.json"),
      JSON.stringify({
        version: 1,
        providers: {
          [PROVIDER]: {
            apiKey: "reload-secret",
            updatedAt: new Date().toISOString(),
          },
        },
      }),
    )
  })

  afterEach(() => {
    process.env.HOME = realHome
    delete process.env[ENV_NAME]
    rmSync(fakeHome, { recursive: true, force: true })
  })

  async function withServer(
    fn: (base: string) => Promise<void>,
    token?: string,
  ): Promise<void> {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      ...(token ? { token } : {}),
      mcpServerFactory: async () =>
        (await createMcpServer({ specs: [], name: "main", version: "0" }))
          .server,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      await fn(`http://127.0.0.1:${port}`)
    } finally {
      await http.stop()
    }
  }

  it("injects stored keys and returns the providers reloaded", async () => {
    const TOKEN = "test-secret-token"
    await withServer(async base => {
      const res = await fetch(`${base}/providers/reload`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ok: boolean
        providers: string[]
      }
      expect(body.ok).toBe(true)
      expect(body.providers).toContain(PROVIDER)
      expect(process.env[ENV_NAME]).toBe("reload-secret")
    }, TOKEN)
  })

  it("is gated by the per-boot session token", async () => {
    const TOKEN = "test-secret-token"
    await withServer(async base => {
      const res = await fetch(`${base}/providers/reload`, { method: "POST" })
      expect(res.status).toBe(401)
      expect(process.env[ENV_NAME]).toBeUndefined()
    }, TOKEN)
  })

  it("rejects non-POST", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/providers/reload`)
      expect(res.status).toBe(404)
    })
  })
})

// ── tiny stubs (mirror bundles-http-routes.test.ts) ──

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
