/**
 * The CALLER IDENTITY of a daemon-spawned session must reach the daemon's
 * `/mcp` gateway — that identity is what makes `message_parent` able to
 * report up (it refuses with "cannot identify the calling session" without
 * one) and what makes the spawns a session makes nest under it instead of
 * landing as depth-0 orphans (see `spawn-attach.ts`).
 *
 * The identity travels TWO ways, because one carrier is not enough:
 *   - the `?callerSessionId=` query on the mount URL (the historical
 *     carrier, read by the trust checks), and
 *   - the `x-agentproto-caller-session-id` header (the robust carrier: a
 *     client or intermediary that rebuilds the mount URL drops the query).
 *
 * And the mount is recognized as "this daemon's own endpoint" by ORIGIN +
 * PATH, not by exact string equality: an ambient mount (a project
 * `.mcp.json`, an operator's global MCP config, a config a supervisor passed
 * down) spells the same endpoint differently — `localhost` vs `127.0.0.1`,
 * a trailing slash, a `?host=…` query — and every one of those spellings
 * used to FAIL the exact match, so the mount was never identity-stamped and
 * the session went anonymous to the gateway.
 */

import { describe, it, expect, vi } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createMcpServer } from "@agentproto/mcp-server"
import type { AcpMcpServer } from "@agentproto/acp"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { CALLER_SESSION_ID_HEADER } from "../sessions.js"
import { spawnAgentSession, stampDaemonCallerSessionId, targetsDaemonGateway } from "../session-spawn.js"
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

describe("caller identity on a daemon mount", () => {
  it("a claude-code spawn's mount carries the session identity BOTH in the query and in a header", async () => {
    const captured: { mcpServers?: AcpMcpServer[] }[] = []
    const startSession = vi.fn(async (opts: { mcpServers?: AcpMcpServer[] }) => {
      captured.push({ mcpServers: opts.mcpServers })
      return {
        id: "agent-session",
        sendPrompt: async () => {},
        interrupt: async () => {},
        stop: async () => {},
        dispose: async () => {},
      } as never
    })
    const daemonMcpUrl = "http://127.0.0.1:18790/mcp"
    const result = await spawnAgentSession(
      {
        registry: { get: () => undefined, list: () => [] } as never,
        resolveAgentAdapter: async () => ({ startSession }) as never,
        daemonMcpUrl,
      } as never,
      { adapter: "claude-code", cwd: "/tmp" },
    )
    expect(result.ok).toBe(true)
    const ownId = result.ok ? result.descriptor.id : "(spawn failed)"
    const entry = captured[0]?.mcpServers?.[0]
    expect(entry?.ref).toContain(`callerSessionId=${ownId}`)
    // The header is the carrier that survives a client that rebuilds the URL.
    expect(entry?.headers?.[CALLER_SESSION_ID_HEADER]).toBe(ownId)
  })

  it("stamps a mount that spells this daemon's endpoint differently (localhost vs 127.0.0.1)", () => {
    // The ambient spelling an operator's config carries. The exact-string
    // match missed it, so the session reached the daemon anonymously: no
    // `message_parent`, and its spawns landed as depth-0 orphans.
    const stamped = stampDaemonCallerSessionId(
      [{ name: "agentproto", transport: "http", ref: "http://localhost:18790/mcp" }],
      { daemonMcpUrl: "http://127.0.0.1:18790/mcp", callerSessionId: "sess_child" },
    )
    expect(stamped?.[0]?.ref).toBe(
      "http://localhost:18790/mcp?callerSessionId=sess_child",
    )
    expect(stamped?.[0]?.headers?.[CALLER_SESSION_ID_HEADER]).toBe("sess_child")
  })

  it("leaves a foreign endpoint and the scoped orchestrator sub-gateway untouched", () => {
    const foreign = { name: "other", transport: "http" as const, ref: "https://example.com/mcp" }
    const scoped = {
      name: "orchestrator",
      transport: "http" as const,
      ref: "http://127.0.0.1:18790/mcp/orchestrator?scope=tok",
    }
    const stamped = stampDaemonCallerSessionId([foreign, scoped], {
      daemonMcpUrl: "http://127.0.0.1:18790/mcp",
      callerSessionId: "sess_child",
    })
    expect(stamped).toEqual([foreign, scoped])
    expect(targetsDaemonGateway(scoped.ref, "http://127.0.0.1:18790/mcp")).toBe(false)
  })

  it("the gateway resolves the caller from the identity header when the URL carries no query", async () => {
    const seen: (string | undefined)[] = []
    const mcpServerFactory = async (
      _denyTools?: ReadonlySet<string>,
      callerSessionId?: string,
    ) => {
      seen.push(callerSessionId)
      const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
      server.tool("probe", "probe", {}, async () => ({
        content: [{ type: "text" as const, text: "ok" }],
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
      // A client that dropped the query (rebuilt the mount URL) but kept the
      // header: the gateway must still know WHO is calling.
      const client = new Client({ name: "identity-header-test", version: "0.0.1" })
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
          requestInit: { headers: { [CALLER_SESSION_ID_HEADER]: "sess_header_only" } },
        }),
      )
      await client.listTools()
      await client.close()
      expect(seen).toContain("sess_header_only")
    } finally {
      await http.stop()
    }
  })
})
