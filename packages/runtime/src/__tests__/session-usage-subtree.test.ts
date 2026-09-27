/**
 * `session_usage` detail fields + `includeSubtree` rollup, over MCP and the
 * `GET /sessions/:id/usage` REST twin:
 *   - reader-supplied cache / reasoning tokens and daemon-measured turns /
 *     toolCalls / durationMs land on `self`,
 *   - the subtree sums a 2-level tree (root → child → grandchild) and leaves
 *     unrelated sessions out,
 *   - `children` lists direct children only, with their own usage,
 *   - a field no session in the subtree reports is omitted, not zeroed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { registerSessionTools } from "../session-tools.js"
import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import type { UsageReadResult } from "../usage.js"

/** One turn: `toolCalls` tool calls, then a cost-bearing usage_update. */
function agentSession(sessionId: string, opts: { cost?: number; toolCalls?: number }): AgentSessionLike {
  return {
    sessionId,
    async *send() {
      for (let i = 0; i < (opts.toolCalls ?? 0); i++) {
        yield { kind: "tool-call", toolCallId: `${sessionId}-t${i}`, toolName: "Read", arguments: {} }
        yield { kind: "tool-result", toolCallId: `${sessionId}-t${i}`, result: "ok" }
      }
      yield {
        kind: "usage_update",
        size: 200_000,
        used: 1_000,
        ...(opts.cost !== undefined ? { cost: { amount: opts.cost, currency: "USD" } } : {}),
      }
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

function parseToolJson(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text) as Record<string, unknown>
}

describe("session_usage detail fields + includeSubtree", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "usage-subtree-test-"))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  /** root → { child → grandchild, bare child }, plus an unrelated session. */
  async function buildTree() {
    const registry = createSessionsRegistry({ persist: false, transcriptDir: join(tmp, "sessions") })
    const reader = (r: UsageReadResult) => async () => r
    const root = registry.spawnAgent({
      workspaceSlug: "w",
      cwd: "/tmp",
      agentSession: agentSession("root", { cost: 1, toolCalls: 2 }),
      adapterSlug: "claude-code",
      label: "root",
      readUsage: reader({
        tokensIn: 100,
        tokensOut: 50,
        cacheReadTokens: 1_000,
        cacheWriteTokens: 200,
        reasoningTokens: 7,
      }),
    })
    const child = registry.spawnAgent({
      workspaceSlug: "w",
      cwd: "/tmp",
      agentSession: agentSession("child", { cost: 0.5 }),
      adapterSlug: "claude-code",
      label: "child",
      parentSessionId: root.id,
      depth: 1,
      readUsage: reader({ tokensIn: 10, tokensOut: 5, cacheReadTokens: 300 }),
    })
    const grandchild = registry.spawnAgent({
      workspaceSlug: "w",
      cwd: "/tmp",
      agentSession: agentSession("grandchild", { cost: 0.25 }),
      adapterSlug: "hermes",
      label: "grandchild",
      parentSessionId: child.id,
      depth: 2,
      readUsage: reader({ tokensIn: 1, tokensOut: 2 }),
    })
    // A child that never reports anything: counted, contributes no fields.
    const bare = registry.spawnAgent({
      workspaceSlug: "w",
      cwd: "/tmp",
      agentSession: agentSession("bare", {}),
      adapterSlug: "fake",
      label: "bare",
      parentSessionId: root.id,
      depth: 1,
    })
    const stranger = registry.spawnAgent({
      workspaceSlug: "w",
      cwd: "/tmp",
      agentSession: agentSession("stranger", { cost: 99 }),
      adapterSlug: "claude-code",
      readUsage: reader({ tokensIn: 9_999, cacheReadTokens: 9_999 }),
    })
    for (const d of [root, child, grandchild, stranger]) await registry.sendPrompt(d.id, "go")
    return { registry, root, child, grandchild, bare, stranger }
  }

  async function connectTools(registry: ReturnType<typeof createSessionsRegistry>) {
    const server = new McpServer({ name: "usage-subtree-test", version: "0.0.0" })
    registerSessionTools(server, { registry, workspace: process.cwd() })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "usage-subtree-client", version: "0.0.0" })
    await client.connect(clientTransport)
    return client
  }

  it("self carries reader cache/reasoning tokens and daemon-measured turns/toolCalls/durationMs", async () => {
    const { registry, root, bare } = await buildTree()
    const client = await connectTools(registry)

    const self = parseToolJson(
      await client.callTool({ name: "session_usage", arguments: { idOrName: root.id } }),
    )
    expect(self).toMatchObject({
      sessionId: root.id,
      costUsd: 1,
      source: "adapter",
      tokensIn: 100,
      tokensOut: 50,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 200,
      reasoningTokens: 7,
      turns: 1,
      toolCalls: 2,
    })
    expect(typeof self.durationMs).toBe("number")
    expect(self.durationMs as number).toBeGreaterThanOrEqual(0)

    // Never prompted: no turn finished, so every activity + token detail
    // field is absent rather than 0.
    const idle = parseToolJson(
      await client.callTool({ name: "session_usage", arguments: { idOrName: bare.id } }),
    )
    for (const k of [
      "tokensIn",
      "cacheReadTokens",
      "cacheWriteTokens",
      "reasoningTokens",
      "turns",
      "toolCalls",
      "durationMs",
    ]) {
      expect(k in idle).toBe(false)
    }
    registry.shutdown()
  })

  it("rolls cost + tokens up across two levels, lists direct children only, omits unreported totals", async () => {
    const { registry, root, child, grandchild, bare } = await buildTree()
    const client = await connectTools(registry)

    const res = parseToolJson(
      await client.callTool({
        name: "session_usage",
        arguments: { idOrName: root.id, includeSubtree: true },
      }),
    ) as {
      sessionId: string
      self: Record<string, unknown>
      subtree: Record<string, unknown>
      children: Array<Record<string, unknown>>
    }

    expect(res.sessionId).toBe(root.id)
    expect(res.self).toMatchObject({ costUsd: 1, cacheReadTokens: 1_000 })
    // root + child + grandchild + bare; the stranger is not in the tree.
    expect(res.subtree.sessions).toBe(4)
    expect(res.subtree.costUsd).toBeCloseTo(1.75, 10)
    expect(res.subtree).toMatchObject({
      tokensIn: 111,
      tokensOut: 57,
      cacheReadTokens: 1_300,
      cacheWriteTokens: 200,
    })

    expect(res.children.map(c => c.id).sort()).toEqual([child.id, bare.id].sort())
    const childRow = res.children.find(c => c.id === child.id)!
    // The child's OWN usage — the grandchild rolls into `subtree`, not here.
    expect(childRow).toMatchObject({ label: "child", costUsd: 0.5, tokensIn: 10, tokensOut: 5 })
    expect(typeof childRow.status).toBe("string")
    const bareRow = res.children.find(c => c.id === bare.id)!
    expect("costUsd" in bareRow).toBe(false)
    expect("tokensIn" in bareRow).toBe(false)

    // A subtree where nothing reports cache tokens omits those totals.
    const leaf = parseToolJson(
      await client.callTool({
        name: "session_usage",
        arguments: { idOrName: grandchild.id, includeSubtree: true },
      }),
    ) as { subtree: Record<string, unknown>; children: unknown[] }
    expect(leaf.subtree).toEqual({ sessions: 1, costUsd: 0.25, tokensIn: 1, tokensOut: 2 })
    expect(leaf.children).toEqual([])

    registry.shutdown()
  })

  it("GET /sessions/:id/usage serves the same projections", async () => {
    const { registry, root } = await buildTree()
    const port = await new Promise<number>((resolve, reject) => {
      const srv = createServer()
      srv.once("error", reject)
      srv.listen(0, "127.0.0.1", () => {
        const p = (srv.address() as AddressInfo).port
        srv.close(() => resolve(p))
      })
    })
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
    const resolveAgentAdapter: AgentAdapterResolver = async () => ({ startSession: vi.fn(), commandPreview: "x" })
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "t", version: "0" })).server,
      conversations,
      events: createRuntimeEvents(),
      heartbeat,
      sessions: registry,
      resolveAgentAdapter,
      meta: { workspace: process.cwd(), registered: [] },
    })
    const base = `http://127.0.0.1:${port}`
    try {
      const client = await connectTools(registry)
      const viaMcp = parseToolJson(
        await client.callTool({
          name: "session_usage",
          arguments: { idOrName: root.id, includeSubtree: true },
        }),
      )

      const plain = await fetch(`${base}/sessions/${root.id}/usage`)
      expect(plain.status).toBe(200)
      expect(await plain.json()).toMatchObject({ sessionId: root.id, costUsd: 1, cacheReadTokens: 1_000 })

      const withTree = await fetch(`${base}/sessions/${root.id}/usage?includeSubtree=true`)
      expect(withTree.status).toBe(200)
      expect(await withTree.json()).toEqual(viaMcp)

      expect((await fetch(`${base}/sessions/sess_nope/usage`)).status).toBe(404)
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })
})
