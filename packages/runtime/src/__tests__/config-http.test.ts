/**
 * `GET /config` / `PATCH /config` (PR-2) — the REST twin of the MCP
 * `config_get`/`config_set` tools. GET is gated like `GET /workspaces`
 * (browser-origin guard, no bearer token needed for a read); PATCH is
 * gated like `DELETE /workspaces/:slug` (per-boot token required).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { loadConfig, saveConfig, type AgentprotoConfig } from "../config.js"
import type { ConfigToolsDeps } from "../config-tools.js"
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

let dir: string
let configPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agp-config-http-"))
  configPath = join(dir, "config.json")
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function writeCfg(cfg: AgentprotoConfig): Promise<void> {
  await saveConfig(cfg, configPath)
}

function makeConfigToolsDeps(bootConfig: AgentprotoConfig): ConfigToolsDeps {
  return {
    loadCfg: () => loadConfig(configPath),
    saveCfg: next => saveConfig(next, configPath),
    configPath: () => configPath,
    bootConfig,
    events: createRuntimeEvents(),
  }
}

async function startServer(configTools: ConfigToolsDeps) {
  const port = await freePort()
  const http = await startHttpServer({
    port,
    token: TOKEN,
    auth: { mode: "none" },
    mcpServerFactory,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    configTools,
    heartbeat: noopHeartbeat(),
    meta: { workspace: process.cwd(), registered: [] },
  })
  return { port, http }
}

describe("GET /config", () => {
  it("returns 200 with revision/path/keys, no token required", async () => {
    await writeCfg({ daemon: { label: "box-1" } })
    const { port, http } = await startServer(makeConfigToolsDeps({}))
    try {
      const res = await fetch(`http://127.0.0.1:${port}/config?keys=daemon.label`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { revision: string; path: string; keys: unknown[] }
      expect(body.path).toBe(configPath)
      expect(body.keys).toEqual([
        expect.objectContaining({ path: "daemon.label", value: "box-1" }),
      ])
    } finally {
      await http.stop()
    }
  })

  it("404s when configTools isn't wired", async () => {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/config`)
      expect(res.status).toBe(404)
    } finally {
      await http.stop()
    }
  })
})

describe("PATCH /config", () => {
  it("rejects without a token or trusted origin (401)", async () => {
    await writeCfg({})
    const { port, http } = await startServer(makeConfigToolsDeps({}))
    try {
      const res = await fetch(`http://127.0.0.1:${port}/config`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "titler.model", value: "z-ai/glm-5" }),
      })
      expect(res.status).toBe(401)
    } finally {
      await http.stop()
    }
  })

  it("writes with a valid token (200) and persists the value", async () => {
    await writeCfg({})
    const { port, http } = await startServer(makeConfigToolsDeps({}))
    try {
      const res = await fetch(`http://127.0.0.1:${port}/config`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ key: "titler.model", value: "z-ai/glm-5" }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; applied: string }
      expect(body).toMatchObject({ ok: true, applied: "hot" })
      expect((await loadConfig(configPath)).titler?.model).toBe("z-ai/glm-5")
    } finally {
      await http.stop()
    }
  })

  it("400s on an unknown key", async () => {
    await writeCfg({})
    const { port, http } = await startServer(makeConfigToolsDeps({}))
    try {
      const res = await fetch(`http://127.0.0.1:${port}/config`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ key: "not.a.real.key", value: 1 }),
      })
      expect(res.status).toBe(400)
    } finally {
      await http.stop()
    }
  })

  it("403s on a non-writable (secret/lockout) key", async () => {
    await writeCfg({})
    const { port, http } = await startServer(makeConfigToolsDeps({}))
    try {
      const res = await fetch(`http://127.0.0.1:${port}/config`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ key: "daemon.port", value: 9999 }),
      })
      expect(res.status).toBe(403)
    } finally {
      await http.stop()
    }
  })

  it("409s on a stale revision", async () => {
    await writeCfg({})
    const { port, http } = await startServer(makeConfigToolsDeps({}))
    try {
      const getRes = await fetch(`http://127.0.0.1:${port}/config`)
      const { revision } = (await getRes.json()) as { revision: string }
      // Mutate out-of-band.
      await writeCfg({ daemon: { label: "changed-elsewhere" } })
      const res = await fetch(`http://127.0.0.1:${port}/config`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ key: "titler.model", value: "x", revision }),
      })
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error: string; revision: string }
      expect(body.error).toBe("stale_revision")
      expect(body.revision).toEqual(expect.any(String))
    } finally {
      await http.stop()
    }
  })
})
