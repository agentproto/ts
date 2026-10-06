/**
 * The 401 on mutating /sessions/* routes must tell a first-time caller where
 * the expected token lives and how to send it: the CLI reads
 * <workspace>/.agentproto/runtime.json on its own, any other HTTP client has
 * to send the token as a bearer.
 */

import { describe, it, expect } from "vitest"
import { createServer, request } from "node:http"
import { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createSessionsRegistry } from "../sessions.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

const TOKEN = "test-secret-token"

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

const conversations: ConversationStore = {
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
const heartbeat: HeartbeatRunner = { start() {}, stop() {}, async fireNow() {} }

function post(port: number, headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/sessions/anything/handoff", method: "POST", headers: { "content-type": "application/json", ...headers } },
      res => {
        let raw = ""
        res.setEncoding("utf8")
        res.on("data", c => (raw += c))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as Record<string, unknown> }))
      },
    )
    req.on("error", reject)
    req.end("{}")
  })
}

async function withServer(run: (port: number) => Promise<void>): Promise<void> {
  const port = await freePort()
  const http = await startHttpServer({
    port,
    token: TOKEN,
    auth: { mode: "bearer" },
    mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "t", version: "0" })).server,
    conversations,
    events: createRuntimeEvents(),
    heartbeat,
    sessions: createSessionsRegistry({ persist: false }),
    meta: { workspace: process.cwd(), registered: [] },
  })
  try {
    await run(port)
  } finally {
    await http.stop()
  }
}

function expectsTokenGuidance(message: string): void {
  expect(message).toContain("<workspace>/.agentproto/runtime.json")
  expect(message).toContain('"token" field')
  expect(message).toContain("The agentproto CLI reads it on its own")
  expect(message).toContain("Authorization: Bearer <token>")
}

describe("sessions_unauthorized message", () => {
  it("names the token file and the bearer header when no token is sent", async () => {
    await withServer(async port => {
      const res = await post(port, {})
      expect(res.status).toBe(401)
      expect(res.body.error).toBe("sessions_unauthorized")
      expectsTokenGuidance(String(res.body.message))
    })
  })

  it("keeps the guidance when the caller comes from a browser origin outside the allowlist", async () => {
    await withServer(async port => {
      const res = await post(port, { origin: "https://example.invalid" })
      expect(res.status).toBe(401)
      const message = String(res.body.message)
      expect(message).toContain("https://example.invalid")
      expectsTokenGuidance(message)
    })
  })

  it("keeps the guidance for a wrong token", async () => {
    await withServer(async port => {
      const res = await post(port, { authorization: "Bearer not-the-token" })
      expect(res.status).toBe(401)
      const message = String(res.body.message)
      expect(message).toContain("Invalid bearer token")
      expectsTokenGuidance(message)
    })
  })
})
