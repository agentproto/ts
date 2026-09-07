/**
 * `GET /brain/query` — HTTP-reachable fuzzy (BM25) search over a workspace's
 * ingested session transcripts, the same engine the `workspace_brain_query`
 * MCP tool calls (brain-tools.ts). Exercises the real REST layer via
 * `startHttpServer` against a fake `WorkspaceBrains` registry, same pattern
 * as workspaces-http-routes.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import type { WorkspaceBrains } from "../workspace-brains.js"

describe("GET /brain/query", () => {
  // GET /brain/query's "unknown workspace" check reads
  // `~/.agentproto/workspaces.json` via `readRegisteredSlugs` — point
  // `HOME` at a throwaway tmp dir so it's a deterministic empty set,
  // same isolation as workspaces-http-routes.test.ts.
  let realHome: string | undefined
  let fakeHome: string

  beforeEach(() => {
    realHome = process.env.HOME
    fakeHome = mkdtempSync(join(tmpdir(), "agentproto-fakehome-"))
    process.env.HOME = fakeHome
  })

  afterEach(() => {
    process.env.HOME = realHome
    rmSync(fakeHome, { recursive: true, force: true })
  })

  async function withServer(
    fn: (base: string) => Promise<void>,
    brains?: WorkspaceBrains,
  ): Promise<void> {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () =>
        (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
      ...(brains ? { brains } : {}),
    })
    try {
      await fn(`http://127.0.0.1:${port}`)
    } finally {
      await http.stop()
    }
  }

  it("501s when no brain registry is wired", async () => {
    await withServer(async base => {
      const res = await fetch(`${base}/brain/query?q=hello`)
      expect(res.status).toBe(501)
      expect((await res.json()) as { error: string }).toMatchObject({
        error: "brain_not_configured",
      })
    })
  })

  it("happy path: maps provider hits to the lean shape", async () => {
    const brains = fakeBrains({
      default: [
        {
          sourceId: "sess-abc123",
          chunkId: "sess-abc123",
          text: "…decided to use BM25 for the brain…",
          score: 4.2,
          metadata: { sessionId: "sess-abc123", title: "Brain search design", slug: "sess-abc123" },
        },
      ],
    })
    await withServer(async base => {
      const res = await fetch(`${base}/brain/query?q=bm25`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        workspace: string
        hits: Array<Record<string, unknown>>
      }
      expect(body.workspace).toBe("default")
      expect(body.hits).toEqual([
        {
          sourceId: "sess-abc123",
          sessionId: "sess-abc123",
          title: "Brain search design",
          score: 4.2,
          snippet: "…decided to use BM25 for the brain…",
        },
      ])
    }, brains)
  })

  it("falls back to parsing sessionId from sourceId when metadata carries none", async () => {
    const brains = fakeBrains({
      default: [
        {
          sourceId: "sess-xyz789#1",
          chunkId: "sess-xyz789#1",
          text: "chunk 1 body",
          score: 1.1,
          metadata: {},
        },
      ],
    })
    await withServer(async base => {
      const res = await fetch(`${base}/brain/query?q=chunk`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { hits: Array<{ sessionId?: string }> }
      expect(body.hits[0]?.sessionId).toBe("sess-xyz789")
    }, brains)
  })

  it("400s on a missing `q`", async () => {
    const brains = fakeBrains({ default: [] })
    await withServer(async base => {
      const res = await fetch(`${base}/brain/query`)
      expect(res.status).toBe(400)
      expect((await res.json()) as { error: string }).toMatchObject({
        error: "missing_query",
      })
    }, brains)
  })

  it("404s on an unknown explicit workspace", async () => {
    const brains = fakeBrains({ default: [] })
    await withServer(async base => {
      const res = await fetch(`${base}/brain/query?q=hi&workspace=ghost-ws`)
      expect(res.status).toBe(404)
      expect((await res.json()) as { error: string }).toMatchObject({
        error: "unknown_workspace",
      })
    }, brains)
  })

  it("500s when the provider throws", async () => {
    const brains: WorkspaceBrains = {
      getBrain: () =>
        stubBrainManager(() =>
          stubProvider(async () => {
            throw new Error("boom")
          }),
        ),
      resolveWorkspace: async () => undefined,
      resolveWorkspaceSlug: (workspace, callerSlug) => workspace ?? callerSlug ?? "default",
    }
    await withServer(async base => {
      const res = await fetch(`${base}/brain/query?q=hi`)
      expect(res.status).toBe(500)
      expect((await res.json()) as { error: string }).toMatchObject({
        error: "brain_query_failed",
      })
    }, brains)
  })
})

// ── fakes ──

interface FakeHit {
  readonly sourceId: string
  readonly chunkId: string
  readonly text: string
  readonly score: number
  readonly metadata: Record<string, unknown>
}

function stubProvider(query: () => Promise<{
  hits: readonly FakeHit[]
  tookMs: number
  engine: string
  modeUsed: "hybrid"
}>) {
  return {
    id: "fake",
    capabilities: {
      vectorSearch: false,
      graphTraversal: false,
      hybridSearch: false,
      multiModal: false,
      streaming: false,
      citations: false,
      maxChunkBytes: 0,
    },
    query,
    async ingest(): Promise<never> {
      throw new Error("unused")
    },
    async listSources() {
      return []
    },
    async getSource() {
      return null
    },
    async deleteSource() {},
    async healthCheck() {
      return true
    },
    async dispose() {},
  }
}

function stubBrainManager(getProvider: () => ReturnType<typeof stubProvider>) {
  return {
    async ingestSession(): Promise<never> {
      throw new Error("unused")
    },
    async ingestPending(): Promise<never> {
      throw new Error("unused")
    },
    async status(): Promise<never> {
      throw new Error("unused")
    },
    getProvider,
    async dispose() {},
  }
}

function fakeBrains(hitsByWorkspace: Record<string, FakeHit[]>): WorkspaceBrains {
  return {
    getBrain: (workspace: string) =>
      stubBrainManager(() =>
        stubProvider(async () => ({
          hits: hitsByWorkspace[workspace] ?? [],
          tookMs: 0,
          engine: "fake",
          modeUsed: "hybrid" as const,
        })),
      ),
    resolveWorkspace: async () => undefined,
    resolveWorkspaceSlug: (workspace, callerSlug) => workspace ?? callerSlug ?? "default",
  }
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
  return {
    start() {},
    stop() {},
    async fireNow() {},
  }
}
