/**
 * Security boundary: `approval_card_decide` and every
 * `ui://agentproto/approval/<id>` card resource must be reachable ONLY on
 * the dedicated `?surface=approval-cards` MCP connection — never on the
 * plain root `/mcp`, and never on a daemon-spawned session's
 * `?callerSessionId=` self-ref connection (most agent-CLI hosts do not
 * honour `_meta.ui.visibility: ["app"]`, so mounting the card anywhere an
 * agent can `resources/read` + call app-only tools would let it mint its
 * own ticket and self-approve).
 *
 * Mirrors `mcp-deny-tools.test.ts`'s pattern: a tiny stand-in
 * `mcpServerFactory` that applies the SAME `surface`/`callerSessionId`
 * gate `index.ts`'s real factory applies, mounted via the real
 * `startHttpServer`/`handleMcp`, driven by a real `StreamableHTTPClientTransport`.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createMcpServer, registerUiResource } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createApprovalsEngine, type ApprovalsEngine } from "../approvals/engine.js"
import { registerApprovalTools } from "../approvals/tools.js"
import { registerApprovalCardDecideTool } from "../approvals/card-tool.js"
import { approvalCardResourceUri, renderApprovalCardHtml } from "../approvals/card.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

let home: string
let engine: ApprovalsEngine

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "approvals-card-surface-"))
  const bus = createSessionEventBus()
  engine = createApprovalsEngine({ homeDir: home, sessionEvents: bus })
})

afterEach(() => {
  engine.dispose()
  rmSync(home, { recursive: true, force: true })
})

/** Stand-in for index.ts's real `mcpServerFactory` — same gate, same
 *  conditional registration, minus everything unrelated to approvals. */
async function mcpServerFactory(
  _denyTools?: ReadonlySet<string>,
  callerSessionId?: string,
  _origin?: string,
  _deferred?: boolean,
  _allowTools?: ReadonlySet<string>,
  surface?: string,
) {
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  registerApprovalTools(server, { engine, ...(callerSessionId ? { callerSessionId } : {}) })
  if (surface === "approval-cards" && !callerSessionId) {
    registerApprovalCardDecideTool(server, engine)
    for (const pending of engine.list({ status: "pending" })) {
      registerUiResource(server, {
        name: `approval-${pending.id}`,
        uri: approvalCardResourceUri(pending.id),
        html: () => renderApprovalCardHtml(engine, pending.id),
      })
    }
  }
  return server
}

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

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
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
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await http.stop()
  }
}

async function connect(base: string, query = ""): Promise<Client> {
  const client = new Client({ name: "approvals-card-surface-test", version: "0.0.1" })
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp${query}`))
  await client.connect(transport)
  return client
}

describe("approval-cards MCP surface: who gets the card", () => {
  it("root /mcp (no surface, no callerSessionId): neither the tool nor any approval resource", async () => {
    await withServer(async base => {
      const requestClient = await connect(base)
      const requested = await requestClient.callTool({
        name: "approval_request",
        arguments: { kind: "send", title: "Send", preview: {}, payload: { x: 1 } },
      })
      const id = (JSON.parse((requested.content as Array<{ text: string }>)[0]!.text) as { id: string }).id
      await requestClient.close()

      const client = await connect(base)
      const { tools } = await client.listTools()
      expect(tools.map(t => t.name)).not.toContain("approval_card_decide")

      await expect(client.readResource({ uri: approvalCardResourceUri(id) })).rejects.toThrow()
      await client.close()
    })
  })

  it("a session-scoped connection (?callerSessionId=..., no surface): same refusal", async () => {
    await withServer(async base => {
      const requestClient = await connect(base, "?callerSessionId=sess_x")
      const requested = await requestClient.callTool({
        name: "approval_request",
        arguments: { kind: "send", title: "Send", preview: {}, payload: { x: 1 } },
      })
      const id = (JSON.parse((requested.content as Array<{ text: string }>)[0]!.text) as { id: string }).id

      const { tools } = await requestClient.listTools()
      expect(tools.map(t => t.name)).not.toContain("approval_card_decide")
      await expect(requestClient.readResource({ uri: approvalCardResourceUri(id) })).rejects.toThrow()
      await requestClient.close()
    })
  })

  it("?surface=approval-cards (no callerSessionId): lists the tool, serves the resource, ticket flow works", async () => {
    await withServer(async base => {
      const requestClient = await connect(base)
      const requested = await requestClient.callTool({
        name: "approval_request",
        arguments: { kind: "send", title: "Send", preview: { to: "a@b.invalid" }, payload: { x: 1 } },
      })
      const id = (JSON.parse((requested.content as Array<{ text: string }>)[0]!.text) as { id: string }).id
      await requestClient.close()

      const cardClient = await connect(base, "?surface=approval-cards")
      const { tools } = await cardClient.listTools()
      expect(tools.map(t => t.name)).toContain("approval_card_decide")

      const read = await cardClient.readResource({ uri: approvalCardResourceUri(id) })
      const content = read.contents[0]
      if (!content || !("text" in content)) throw new Error("resource read returned no text content")
      const ticket = content.text.match(/var TICKET = "([^"]+)"/)?.[1]
      expect(ticket).toBeTruthy()

      const decided = await cardClient.callTool({
        name: "approval_card_decide",
        arguments: { approvalId: id, decision: "approve", ticket },
      })
      expect((decided as { isError?: boolean }).isError).toBeFalsy()
      expect(engine.get(id)?.status).toBe("approved")
      await cardClient.close()
    })
  })

  it("?surface=approval-cards&callerSessionId=... is refused outright (403), not silently downgraded", async () => {
    await withServer(async base => {
      const client = new Client({ name: "refused-test", version: "0.0.1" })
      const transport = new StreamableHTTPClientTransport(
        new URL(`${base}/mcp?surface=approval-cards&callerSessionId=sess_y`),
      )
      await expect(client.connect(transport)).rejects.toThrow()
    })
  })
})
