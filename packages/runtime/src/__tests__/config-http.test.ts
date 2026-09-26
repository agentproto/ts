/**
 * `GET /config` / `PATCH /config` (PR-2) — the REST twin of the MCP
 * `config_get`/`config_set` tools. Both routes require the per-boot session
 * token, same gate as `DELETE /workspaces/:slug` — a read here can surface
 * secret-presence/fingerprint info for every secret field on the box, so it
 * is gated like a mutating route rather than like `GET /workspaces`.
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
  it("returns 200 with revision/path/keys when given a valid token", async () => {
    await writeCfg({ daemon: { label: "box-1" } })
    const { port, http } = await startServer(makeConfigToolsDeps({}))
    try {
      const res = await fetch(`http://127.0.0.1:${port}/config?keys=daemon.label`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
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

  it("rejects without a token or trusted origin (401)", async () => {
    await writeCfg({ daemon: { label: "box-1" } })
    const { port, http } = await startServer(makeConfigToolsDeps({}))
    try {
      const res = await fetch(`http://127.0.0.1:${port}/config`)
      expect(res.status).toBe(401)
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
      const getRes = await fetch(`http://127.0.0.1:${port}/config`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
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

  it("succeeds despite an unrelated pre-existing schema issue already on disk", async () => {
    // A legacy hand-edit / older-daemon-written value that fails schema
    // validation on ITS OWN, unrelated to the key this write touches.
    await writeCfg({ worktrees: { isolation: "bogus-legacy-value" as never } })
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
      const onDisk = await loadConfig(configPath)
      expect(onDisk.titler?.model).toBe("z-ai/glm-5")
      // The unrelated pre-existing issue is left untouched, not silently
      // "fixed" by this write.
      expect(onDisk.worktrees?.isolation).toBe("bogus-legacy-value")
    } finally {
      await http.stop()
    }
  })
})

describe("GET /config secret redaction", () => {
  it("never returns a raw secret nested under a non-secret container key (profiles)", async () => {
    const secrets = [
      "alpha-tunnel-secret-1234",
      "alpha-daemon-secret-5678",
      "beta-tunnel-secret-9999",
    ]
    await writeCfg({
      profiles: {
        alpha: { tunnel: { token: secrets[0] }, daemon: { authToken: secrets[1] } },
        beta: { tunnel: { token: secrets[2] } },
      },
    })
    const { port, http } = await startServer(makeConfigToolsDeps({}))
    try {
      const res = await fetch(`http://127.0.0.1:${port}/config?keys=profiles`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(res.status).toBe(200)
      const bodyText = await res.text()
      for (const secret of secrets) {
        expect(bodyText).not.toContain(secret)
      }
      const body = JSON.parse(bodyText) as { keys: Array<{ path: string; value: any }> }
      const row = body.keys.find(k => k.path === "profiles")
      expect(row?.value.alpha.tunnel.token.set).toBe(true)
      expect(row?.value.alpha.daemon.authToken.set).toBe(true)
      expect(row?.value.beta.tunnel.token.set).toBe(true)
    } finally {
      await http.stop()
    }
  })
})
