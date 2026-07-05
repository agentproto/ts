/**
 * End-to-end proof of the spawn-role-profiles hard tool gate on the
 * PLAIN `/mcp` gateway (as opposed to the orchestrator's curated
 * allowlist, covered in orchestrator-gateway.test.ts). This is the
 * surface a hermes executor-role child actually connects to (see
 * `session-spawn.ts`'s `denyTools` query param) — it must keep every
 * non-delegation tool (the child needs fs/command tools to do real
 * work) while excluding `agent_start`/`agent_prompt`.
 */

import { describe, it, expect } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { withToolExclusion } from "../tool-subset.js"
import { DELEGATION_TOOL_NAMES } from "../role.js"
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

// A tiny stand-in for the daemon's real mcpServerFactory (index.ts) —
// registers a probe tool set including the delegation surface, and
// applies the SAME `withToolExclusion` wrap the real factory applies
// when `denyTools` is non-empty.
async function mcpServerFactory(denyTools?: ReadonlySet<string>) {
  const { server: rawServer } = await createMcpServer({
    specs: [],
    name: "main",
    version: "0",
  })
  let server = rawServer
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

describe("/mcp?denyTools= — the hard tool gate on the plain daemon gateway", () => {
  it("strips exactly the delegation tools, keeps everything else", async () => {
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
      const client = new Client({ name: "denytools-test", version: "0.0.1" })
      const url = new URL(`http://127.0.0.1:${port}/mcp?denyTools=${DELEGATION_TOOL_NAMES.join(",")}`)
      const transport = new StreamableHTTPClientTransport(url)
      await client.connect(transport)
      const { tools } = await client.listTools()
      const names = tools.map(t => t.name).sort()
      expect(names).toEqual(["command_execute", "file_read"])
      await client.close()
    } finally {
      await http.stop()
    }
  })

  it("registers every tool (including delegation) when no denyTools query param is present", async () => {
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
      const client = new Client({ name: "denytools-absent-test", version: "0.0.1" })
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
      await client.connect(transport)
      const { tools } = await client.listTools()
      const names = tools.map(t => t.name).sort()
      expect(names).toEqual(["agent_prompt", "agent_start", "command_execute", "file_read"])
      await client.close()
    } finally {
      await http.stop()
    }
  })
})
