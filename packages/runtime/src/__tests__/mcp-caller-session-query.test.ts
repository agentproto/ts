/**
 * End-to-end proof of the `?callerSessionId=` query-param threading on the
 * PLAIN `/mcp` gateway (PR 7 / Gap 7) — mirrors mcp-deny-tools.test.ts's
 * proof of `?denyTools=` on the same surface. `session-spawn.ts` bakes
 * `callerSessionId=<child's own id>` onto the daemon-self-ref URL it injects
 * for a hermes child with no explicit `mcpServers`; this is the daemon side
 * that reads it back off THAT request and threads it into whatever the real
 * `mcpServerFactory` (index.ts) does with it (`registerCommandTools`).
 */

import { describe, it, expect } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
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
  return {
    start() {},
    stop() {},
    async fireNow() {},
  }
}

describe("/mcp?callerSessionId= — per-request caller identity threaded to the factory", () => {
  it("passes the query param's value through to mcpServerFactory's second argument", async () => {
    const received: Array<string | undefined> = []
    async function mcpServerFactory(
      _denyTools?: ReadonlySet<string>,
      callerSessionId?: string,
    ) {
      received.push(callerSessionId)
      const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
      server.tool("probe", "probe", {}, async () => ({
        content: [{ type: "text", text: "ok" }],
      }))
      return server
    }

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
      const client = new Client({ name: "caller-session-test", version: "0.0.1" })
      const url = new URL(`http://127.0.0.1:${port}/mcp?callerSessionId=sess_abcd1234`)
      const transport = new StreamableHTTPClientTransport(url)
      await client.connect(transport)
      await client.close()

      // The Streamable HTTP client transport can issue more than one POST
      // per connect/close cycle (each hits `handleMcp` → the factory
      // afresh, per its stateless-per-request contract) — assert every
      // call this connection made carried the query param, not a fixed
      // call count.
      expect(received.length).toBeGreaterThan(0)
      expect(received.every(v => v === "sess_abcd1234")).toBe(true)
    } finally {
      await http.stop()
    }
  })

  it("passes undefined when the query param is absent — no caller-identity fabrication", async () => {
    const received: Array<string | undefined> = []
    async function mcpServerFactory(
      _denyTools?: ReadonlySet<string>,
      callerSessionId?: string,
    ) {
      received.push(callerSessionId)
      const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
      server.tool("probe", "probe", {}, async () => ({
        content: [{ type: "text", text: "ok" }],
      }))
      return server
    }

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
      const client = new Client({ name: "caller-session-absent-test", version: "0.0.1" })
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
      await client.connect(transport)
      await client.close()

      expect(received.length).toBeGreaterThan(0)
      expect(received.every(v => v === undefined)).toBe(true)
    } finally {
      await http.stop()
    }
  })
})
