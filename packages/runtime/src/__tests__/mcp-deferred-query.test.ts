/**
 * The per-mount `/mcp?deferred=1|0` override (harness-parity item 3, see
 * `deferred-tools.ts` + `index.ts`'s `mcpServerFactory`). Mirrors
 * `mcp-deny-tools.test.ts`'s structure — a tiny stand-in factory applying
 * the SAME conditional `withDeferredTools` wrap the real `mcpServerFactory`
 * applies, proving `?deferred=` composes with `?denyTools=` rather than
 * one silently overriding the other.
 */

import { describe, it, expect } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { withToolExclusion } from "../tool-subset.js"
import { withDeferredTools } from "../deferred-tools.js"
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

// A stand-in for the daemon's real mcpServerFactory (index.ts) — this
// gateway boots with `opts.deferredTools` OFF by default (mirrors the
// daemon's own global default), so a bare `/mcp` connection is eager;
// `?deferred=1` on a per-request basis is what turns it on, and `denyTools`
// composes on top regardless.
async function mcpServerFactory(
  denyTools?: ReadonlySet<string>,
  _callerSessionId?: string,
  _origin?: string,
  deferred?: boolean,
) {
  const { server: rawServer } = await createMcpServer({ specs: [], name: "main", version: "0" })
  let server = deferred === true ? withDeferredTools(rawServer, { alwaysOn: new Set(["agent_start"]) }) : rawServer
  if (denyTools && denyTools.size > 0) {
    server = withToolExclusion(server, denyTools)
  }
  for (const name of ["agent_start", "agent_prompt", "command_execute", "file_read"]) {
    server.tool(name, `probe ${name}`, {}, async () => ({
      content: [{ type: "text", text: name }],
    }))
  }
  return server
}

async function listToolNames(url: string): Promise<string[]> {
  const client = new Client({ name: "deferred-query-test", version: "0.0.1" })
  const transport = new StreamableHTTPClientTransport(new URL(url))
  await client.connect(transport)
  const { tools } = await client.listTools()
  const names = tools.map(t => t.name).sort()
  await client.close()
  return names
}

describe("/mcp?deferred= — per-mount override for deferred/lazy tool loading", () => {
  it("absent ⇒ falls through to the gateway's own default (eager here)", async () => {
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
      const names = await listToolNames(`http://127.0.0.1:${port}/mcp`)
      expect(names).toEqual(["agent_prompt", "agent_start", "command_execute", "file_read"])
    } finally {
      await http.stop()
    }
  })

  it("?deferred=1 ⇒ tools/list shrinks to the always-on set + tool_search, tools stay fully callable", async () => {
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
      const names = await listToolNames(`http://127.0.0.1:${port}/mcp?deferred=1`)
      expect(names).toEqual(["agent_start", "tool_search"])

      const client = new Client({ name: "deferred-query-call-test", version: "0.0.1" })
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?deferred=1`)))
      const res = (await client.callTool({ name: "file_read", arguments: {} })) as { isError?: boolean }
      expect(res.isError).toBeFalsy()
      await client.close()
    } finally {
      await http.stop()
    }
  })

  it("?deferred=1&denyTools=... composes — deny wins even over the always-on set", async () => {
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
      const names = await listToolNames(`http://127.0.0.1:${port}/mcp?deferred=1&denyTools=agent_start`)
      // agent_start was in the always-on set, but denyTools strips it
      // before it's even registered — outermost wrap wins unconditionally.
      expect(names).toEqual(["tool_search"])
    } finally {
      await http.stop()
    }
  })

  it("?deferred=0 explicitly forces eager, same as omitting it here", async () => {
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
      const names = await listToolNames(`http://127.0.0.1:${port}/mcp?deferred=0`)
      expect(names).toEqual(["agent_prompt", "agent_start", "command_execute", "file_read"])
    } finally {
      await http.stop()
    }
  })
})
