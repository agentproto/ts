/**
 * Surface wiring for the worktree-status query surface — `GET /worktrees`
 * and the `worktree_status` MCP tool. Both are thin shells over an injected
 * `listWorktreeStatuses` port (mirrors `listCatalogModels` / `GET /catalog/models`):
 * this file checks the query params reach the lister and the "not configured"
 * fallback, not the join itself.
 */

import { describe, it, expect } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { startHttpServer, type RuntimeHttpServerHandle } from "../http-server.js"
import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import type { WorktreeStatusLister, WorktreeStatusView } from "../worktree-status.js"

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

const FAKE_VIEWS: WorktreeStatusView[] = [
  {
    path: "/tmp/wt/one",
    branch: "wt/one",
    class: "hold",
    reclaimable: false,
    pr: { state: "open", number: 7 },
    sessions: [
      {
        id: "s1",
        adapterSlug: "claude-code",
        model: "claude-opus-4",
        status: "running",
        startedAt: "2026-07-20T10:00:00Z",
      },
    ],
    liveness: { state: "sessions", sessionCount: 1 },
  },
  {
    path: "/tmp/wt/two",
    branch: "wt/two",
    class: "reclaim",
    reclaimable: true,
    pr: { state: "merged" },
    sessions: [],
    liveness: { state: "idle", sessionCount: 0 },
  },
]

describe("GET /worktrees — HTTP route", () => {
  async function start(
    listWorktreeStatuses?: WorktreeStatusLister,
  ): Promise<RuntimeHttpServerHandle> {
    const port = await freePort()
    return startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
      ...(listWorktreeStatuses ? { listWorktreeStatuses } : {}),
    })
  }

  it("501 with a clear message when no lister is wired", async () => {
    const http = await start()
    try {
      const res = await fetch(`http://127.0.0.1:${http.url.split(":").pop()}/worktrees`)
      expect(res.status).toBe(501)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe("worktree_status_not_configured")
    } finally {
      await http.stop()
    }
  })

  it("200 with the worktree list, forwarding repoRoot query param", async () => {
    let seenRoot: string | undefined
    const listWorktreeStatuses: WorktreeStatusLister = async repoRoot => {
      seenRoot = repoRoot
      return FAKE_VIEWS
    }
    const http = await start(listWorktreeStatuses)
    try {
      const res = await fetch(
        `http://127.0.0.1:${http.url.split(":").pop()}/worktrees?repoRoot=/some/repo`,
      )
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ worktrees: FAKE_VIEWS })
      expect(seenRoot).toBe("/some/repo")
    } finally {
      await http.stop()
    }
  })

  it("filters to open PRs when ?openOnly=1", async () => {
    const listWorktreeStatuses: WorktreeStatusLister = async () => FAKE_VIEWS
    const http = await start(listWorktreeStatuses)
    try {
      const res = await fetch(
        `http://127.0.0.1:${http.url.split(":").pop()}/worktrees?repoRoot=/repo&openOnly=1`,
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { worktrees: WorktreeStatusView[] }
      expect(body.worktrees).toHaveLength(1)
      expect(body.worktrees[0]!.pr).toEqual({ state: "open", number: 7 })
    } finally {
      await http.stop()
    }
  })

  it("500 with the error message when the lister throws", async () => {
    const listWorktreeStatuses: WorktreeStatusLister = async () => {
      throw new Error("forge offline")
    }
    const http = await start(listWorktreeStatuses)
    try {
      const res = await fetch(
        `http://127.0.0.1:${http.url.split(":").pop()}/worktrees?repoRoot=/repo`,
      )
      expect(res.status).toBe(500)
      const body = (await res.json()) as { error: string; message: string }
      expect(body.error).toBe("worktree_status_failed")
      expect(body.message).toBe("forge offline")
    } finally {
      await http.stop()
    }
  })
})

describe("worktree_status — MCP tool", () => {
  async function harness(listWorktreeStatuses?: WorktreeStatusLister) {
    const registry = createSessionsRegistry({ persist: false })
    const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
    registerSessionTools(server, {
      workspace: process.cwd(),
      registry,
      ...(listWorktreeStatuses ? { listWorktreeStatuses } : {}),
    })

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "test", version: "0.0.1" })
    await client.connect(clientTransport)
    return { client, close: async () => client.close() }
  }

  function payload(result: unknown): { worktrees: WorktreeStatusView[] } {
    const content = (result as { content: Array<{ text: string }> }).content
    return JSON.parse(content[0]!.text) as { worktrees: WorktreeStatusView[] }
  }

  it("reports 'not enabled' when no lister is wired", async () => {
    const h = await harness()
    try {
      const result = await h.client.callTool({ name: "worktree_status", arguments: {} })
      expect((result as { isError?: boolean }).isError).toBe(true)
      const content = (result as { content: Array<{ text: string }> }).content
      expect(content[0]!.text).toContain("worktree_status is not enabled")
    } finally {
      await h.close()
    }
  })

  it("returns compact worktrees by default and the full view via full:true, forwarding repoRoot", async () => {
    let seenRoot: string | undefined
    const h = await harness(async repoRoot => {
      seenRoot = repoRoot
      return FAKE_VIEWS
    })
    try {
      // Default: COMPACT projection — no per-session roster.
      const compactResult = await h.client.callTool({
        name: "worktree_status",
        arguments: { repoRoot: "/some/repo" },
      })
      const compact = payload(compactResult)
      expect(compact.worktrees).toHaveLength(2)
      expect(compact.worktrees[0]).toMatchObject({
        path: "/tmp/wt/one",
        branch: "wt/one",
        class: "hold",
        pr: { state: "open", number: 7 },
        liveness: { state: "sessions", sessionCount: 1 },
      })
      expect(compact.worktrees[0]).not.toHaveProperty("sessions")
      expect(compact.worktrees[1]).not.toHaveProperty("sessions")
      expect(seenRoot).toBe("/some/repo")

      // full:true — the complete unprojected WorktreeStatusView.
      const fullResult = await h.client.callTool({
        name: "worktree_status",
        arguments: { repoRoot: "/some/repo", full: true },
      })
      expect(payload(fullResult)).toEqual({ worktrees: FAKE_VIEWS })
    } finally {
      await h.close()
    }
  })

  it("honors openOnly from the MCP tool", async () => {
    const h = await harness(async () => FAKE_VIEWS)
    try {
      const result = await h.client.callTool({
        name: "worktree_status",
        arguments: { repoRoot: "/repo", openOnly: true },
      })
      const body = payload(result)
      expect(body.worktrees).toHaveLength(1)
      expect(body.worktrees[0]!.pr).toEqual({ state: "open", number: 7 })
    } finally {
      await h.close()
    }
  })

  it("page-walk with limit=1 covers exactly the unpaginated list; rows COMPACT by default", async () => {
    const h = await harness(async () => FAKE_VIEWS)
    try {
      // Default call: the { worktrees } envelope, COMPACT rows, no page fields.
      const result = await h.client.callTool({
        name: "worktree_status",
        arguments: { repoRoot: "/repo" },
      })
      const body = payload(result)
      expect(body.worktrees.map(w => w.path)).toEqual(FAKE_VIEWS.map(w => w.path))
      expect(body.worktrees[0]).not.toHaveProperty("sessions")
      expect(body.worktrees[1]).not.toHaveProperty("sessions")

      // Page-walk: the union of pages equals the unpaginated list exactly.
      const union: Array<{ path: string }> = []
      let cursor: string | undefined
      do {
        const page = JSON.parse(
          (
            (await h.client.callTool({
              name: "worktree_status",
              arguments: { repoRoot: "/repo", limit: 1, ...(cursor ? { cursor } : {}) },
            })) as { content: Array<{ text: string }> }
          ).content[0]!.text,
        ) as { items: WorktreeStatusView[]; total: number; nextCursor?: string }
        expect(page.total).toBe(2)
        union.push(...page.items)
        cursor = page.nextCursor
      } while (cursor)
      expect(union.map(w => w.path)).toEqual(FAKE_VIEWS.map(w => w.path))
    } finally {
      await h.close()
    }
  })
})
