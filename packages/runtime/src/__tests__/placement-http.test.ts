/**
 * `POST /sessions/agent` with `placement`: the body parser refuses a bad
 * ladder or one combined with a top-level `sandbox` (400 `placement_invalid`),
 * and an exhausted ladder is a 502 `sandbox_placement_exhausted`.
 */

import { describe, it, expect } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import { createSessionsRegistry } from "../sessions.js"
import { createRuntimeEvents } from "../events.js"

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

async function withServer(run: (post: (body: unknown) => Promise<{ status: number; json: Record<string, unknown> }>) => Promise<void>) {
  const registry = createSessionsRegistry({ persist: false })
  const resolveAgentAdapter: AgentAdapterResolver = async () => ({
    commandPreview: "mock",
    async startSession() {
      throw new Error("no agent should start")
    },
  })
  const port = await freePort()
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
    conversations: {
      async open() {},
      async appendTurn() {},
      async read() {
        return { meta: {} as never, turns: [] }
      },
      async list() {
        return []
      },
      pathFor: (id: string) => id,
    },
    events: createRuntimeEvents(),
    heartbeat: { start() {}, stop() {}, async fireNow() {} },
    sessions: registry,
    resolveAgentAdapter,
    resolveSandboxProvider: async () => null,
    meta: { workspace: process.cwd(), registered: [] },
  })
  try {
    await run(async body => {
      const res = await fetch(`http://127.0.0.1:${port}/sessions/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      return { status: res.status, json: (await res.json()) as Record<string, unknown> }
    })
  } finally {
    await http.stop()
    registry.shutdown()
  }
}

describe("POST /sessions/agent placement", () => {
  it("refuses placement together with a top-level sandbox (400)", async () => {
    await withServer(async post => {
      const { status, json } = await post({ adapter: "mock", cwd: "/tmp", sandbox: "e2b", placement: { ladder: [{ sandbox: "local" }] } })
      expect(status).toBe(400)
      expect(json.error).toBe("placement_invalid")
    })
  })

  it.each([
    ["an empty ladder", { ladder: [] }],
    ["a rung without a sandbox", { ladder: [{ model: "m" }] }],
    ["not an object", "e2b"],
  ])("refuses %s (400)", async (_name, placement) => {
    await withServer(async post => {
      const { status, json } = await post({ adapter: "mock", cwd: "/tmp", placement })
      expect(status).toBe(400)
      expect(json.error).toBe("placement_invalid")
    })
  })

  it("an exhausted ladder is a 502 listing every attempt", async () => {
    await withServer(async post => {
      const { status, json } = await post({
        adapter: "mock",
        cwd: "/tmp",
        placement: { ladder: [{ sandbox: "nowhere-1" }, { sandbox: "nowhere-2" }] },
      })
      expect(status).toBe(502)
      expect(json.error).toBe("sandbox_placement_exhausted")
      expect(String(json.message)).toContain("nowhere-1")
      expect(String(json.message)).toContain("nowhere-2")
    })
  })
})
