/**
 * Mutating `/auth/profiles*` and `/apps/:appId/apply` REST routes take the
 * same credential as the mutating `/sessions/*` routes: the per-boot token
 * (or an allowlisted Origin), no foreign browser Origin without the bearer,
 * and a JSON content-type on writes. Reads stay open. Exercises the real
 * REST layer via `startHttpServer`.
 *
 * The "authenticated" cases send a body the handler rejects (400) so the
 * test proves the request got past the gate without writing credentials or
 * installing anything.
 */

import { describe, expect, it } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

const TOKEN = "profiles-apps-test-token"
const json = { "content-type": "application/json" }
const authed = { ...json, authorization: `Bearer ${TOKEN}` }

async function withServer(
  fn: (base: string, installCalls: string[]) => Promise<void>,
): Promise<void> {
  const port = await freePort()
  const installCalls: string[] = []
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    token: TOKEN,
    mcpServerFactory: async () =>
      (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    meta: { workspace: process.cwd(), registered: [] },
    appRegistry: { getApp: () => undefined } as never,
    performAppInstall: async (dir) => {
      installCalls.push(dir)
      return { ok: false, error: "stub: not installed" }
    },
    listRegisteredToolIds: async () => [],
  })
  try {
    await fn(`http://127.0.0.1:${port}`, installCalls)
  } finally {
    await http.stop()
  }
}

describe("POST /auth/profiles and sibling writes", () => {
  const writes: Array<[string, string]> = [
    ["POST", "/auth/profiles"],
    ["PATCH", "/auth/profiles/some-id"],
    ["DELETE", "/auth/profiles/some-id"],
  ]

  for (const [method, path] of writes) {
    it(`${method} ${path}: no token is refused with 401`, async () => {
      await withServer(async (base) => {
        const res = await fetch(`${base}${path}`, { method, headers: json, body: method === "DELETE" ? undefined : "{}" })
        expect(res.status).toBe(401)
        expect(((await res.json()) as { error: string }).error).toBe("sessions_unauthorized")
      })
    })

    it(`${method} ${path}: wrong token is refused with 401`, async () => {
      await withServer(async (base) => {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: { ...json, authorization: "Bearer nope" },
          body: method === "DELETE" ? undefined : "{}",
        })
        expect(res.status).toBe(401)
      })
    })
  }

  it("a foreign browser Origin is refused with 403, even with a correct-looking body", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/auth/profiles`, {
        method: "POST",
        headers: { ...json, origin: "https://evil.example" },
        body: "{}",
      })
      expect(res.status).toBe(403)
    })
  })

  it("a text/plain write (CORS simple request) is refused with 415, token or not", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/auth/profiles`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" },
        body: JSON.stringify({ id: "x", endpoint: "https://x.example", method: "api-key", credential: "k" }),
      })
      expect(res.status).toBe(415)
      expect(((await res.json()) as { error: string }).error).toBe("unsupported_media_type")
    })
  })

  it("with the token and JSON the request reaches the handler (400 invalid_input, nothing written)", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/auth/profiles`, {
        method: "POST",
        headers: authed,
        body: JSON.stringify({ id: "", endpoint: "", method: "api-key" }),
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe("invalid_input")
    })
  })

  it("GET /auth/profiles stays open without a token", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/auth/profiles`)
      expect(res.status).toBe(200)
    })
  })
})

describe("POST/DELETE /apps/:appId/apply", () => {
  it("POST without a token is refused with 401 and installs nothing", async () => {
    await withServer(async (base, installCalls) => {
      const res = await fetch(`${base}/apps/demo/apply`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ dir: "/tmp/some-app" }),
      })
      expect(res.status).toBe(401)
      expect(installCalls).toEqual([])
    })
  })

  it("DELETE without a token is refused with 401", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/apps/demo/apply`, { method: "DELETE", headers: json })
      expect(res.status).toBe(401)
    })
  })

  it("a foreign browser Origin is refused with 403 and installs nothing", async () => {
    await withServer(async (base, installCalls) => {
      const res = await fetch(`${base}/apps/demo/apply`, {
        method: "POST",
        headers: { ...json, origin: "https://evil.example" },
        body: JSON.stringify({ dir: "/tmp/some-app" }),
      })
      expect(res.status).toBe(403)
      expect(installCalls).toEqual([])
    })
  })

  it("a text/plain POST is refused with 415 and installs nothing", async () => {
    await withServer(async (base, installCalls) => {
      const res = await fetch(`${base}/apps/demo/apply`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" },
        body: JSON.stringify({ dir: "/tmp/some-app" }),
      })
      expect(res.status).toBe(415)
      expect(installCalls).toEqual([])
    })
  })

  it("with the token and JSON the request reaches the handler", async () => {
    await withServer(async (base, installCalls) => {
      const res = await fetch(`${base}/apps/demo/apply`, {
        method: "POST",
        headers: authed,
        body: JSON.stringify({ dir: "/tmp/some-app" }),
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe("stub: not installed")
      expect(installCalls).toEqual(["/tmp/some-app"])
    })
  })
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
