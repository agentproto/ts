/**
 * `GET /brain/query` — HTTP-reachable fuzzy (BM25) search over ingested
 * session transcripts, the same engine the `workspace_brain_query` MCP
 * tool calls (brain-tools.ts). The daemon splits its corpus across
 * MULTIPLE per-workspace brains, so the default mode (`workspace=all` or
 * omitted) federates every registered workspace + the implicit `default`
 * bucket; a NAMED `workspace` slug keeps single-brain behavior. Exercises
 * the real REST layer via `startHttpServer` against a fake `WorkspaceBrains`
 * registry, same pattern as workspaces-http-routes.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
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
  // GET /brain/query's federated enumeration + "unknown workspace" check
  // both read `~/.agentproto/workspaces.json` — point `HOME` at a
  // throwaway tmp dir so the registered-workspace set is deterministic,
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

  /** Register extra workspace slugs in the fake `~/.agentproto/workspaces.json`
   *  so federated enumeration sees them (`default` is always implicit and
   *  never needs registering). */
  function registerWorkspaces(...slugs: string[]): void {
    const dir = join(fakeHome, ".agentproto")
    mkdirSync(dir, { recursive: true })
    const now = new Date().toISOString()
    writeFileSync(
      join(dir, "workspaces.json"),
      JSON.stringify({
        version: 1,
        workspaces: slugs.map(slug => ({
          slug,
          path: join(fakeHome, slug),
          addedAt: now,
          updatedAt: now,
        })),
      }),
    )
  }

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

  it("named workspace: maps provider hits to the lean shape", async () => {
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
      const res = await fetch(`${base}/brain/query?q=bm25&workspace=default`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        workspace: string
        hits: Array<Record<string, unknown>>
      }
      expect(body.workspace).toBe("default")
      expect(body.hits).toEqual([
        {
          sourceId: "sess-abc123",
          workspace: "default",
          sessionId: "sess-abc123",
          title: "Brain search design",
          score: 4.2,
          snippet: "…decided to use BM25 for the brain…",
        },
      ])
    }, brains)
  })

  it("named workspace: falls back to parsing sessionId from sourceId when metadata carries none", async () => {
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
      const res = await fetch(`${base}/brain/query?q=chunk&workspace=default`)
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

  it("404s on an unknown NAMED workspace", async () => {
    const brains = fakeBrains({ default: [] })
    await withServer(async base => {
      const res = await fetch(`${base}/brain/query?q=hi&workspace=ghost-ws`)
      expect(res.status).toBe(404)
      expect((await res.json()) as { error: string }).toMatchObject({
        error: "unknown_workspace",
      })
    }, brains)
  })

  it("500s when a NAMED workspace's provider throws", async () => {
    registerWorkspaces("default")
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
      const res = await fetch(`${base}/brain/query?q=hi&workspace=default`)
      expect(res.status).toBe(500)
      expect((await res.json()) as { error: string }).toMatchObject({
        error: "brain_query_failed",
      })
    }, brains)
  })

  it("federated (default `workspace=all`): merges hits across every registered brain, tags each with its workspace, sorts by score desc, and truncates to topK", async () => {
    registerWorkspaces("agentik-studio", "agentproto")
    const brains = fakeBrains({
      default: [
        {
          sourceId: "sess-d1",
          chunkId: "sess-d1",
          text: "default hit",
          score: 2,
          metadata: { sessionId: "sess-d1", title: "Default session" },
        },
      ],
      "agentik-studio": [
        {
          sourceId: "sess-s1",
          chunkId: "sess-s1",
          text: "studio hit — highest score",
          score: 9,
          metadata: { sessionId: "sess-s1", title: "Studio session" },
        },
      ],
      agentproto: [
        {
          sourceId: "sess-p1",
          chunkId: "sess-p1",
          text: "agentproto hit",
          score: 5,
          metadata: { sessionId: "sess-p1", title: "Agentproto session" },
        },
      ],
    })
    await withServer(async base => {
      const res = await fetch(`${base}/brain/query?q=hit&topK=2`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        workspace: string
        hits: Array<{ sessionId?: string; workspace: string; score: number }>
        workspacesErrored?: string[]
      }
      expect(body.workspace).toBe("all")
      expect(body.workspacesErrored).toBeUndefined()
      // Sorted by score desc, truncated to topK=2 across ALL three brains.
      expect(body.hits).toHaveLength(2)
      expect(body.hits[0]).toMatchObject({ sessionId: "sess-s1", workspace: "agentik-studio", score: 9 })
      expect(body.hits[1]).toMatchObject({ sessionId: "sess-p1", workspace: "agentproto", score: 5 })
    }, brains)
  })

  it("federated: a per-brain provider throw is swallowed and listed in workspacesErrored, other brains' hits still return", async () => {
    registerWorkspaces("agentik-studio")
    const brains: WorkspaceBrains = {
      getBrain: (workspace: string) => {
        if (workspace === "agentik-studio") {
          return stubBrainManager(() =>
            stubProvider(async () => {
              throw new Error("studio brain is down")
            }),
          )
        }
        return stubBrainManager(() =>
          stubProvider(async () => ({
            hits: [
              {
                sourceId: "sess-ok",
                chunkId: "sess-ok",
                text: "still works",
                score: 1,
                metadata: { sessionId: "sess-ok", title: "OK session" },
              },
            ],
            tookMs: 0,
            engine: "fake",
            modeUsed: "hybrid" as const,
          })),
        )
      },
      resolveWorkspace: async () => undefined,
      resolveWorkspaceSlug: (workspace, callerSlug) => workspace ?? callerSlug ?? "default",
    }
    await withServer(async base => {
      const res = await fetch(`${base}/brain/query?q=hit`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        workspace: string
        hits: Array<{ sessionId?: string; workspace: string }>
        workspacesErrored?: string[]
      }
      expect(body.workspace).toBe("all")
      expect(body.workspacesErrored).toEqual(["agentik-studio"])
      expect(body.hits.every(h => h.sessionId === "sess-ok")).toBe(true)
    }, brains)
  })

  it('explicit workspace=all is equivalent to the default federated mode', async () => {
    const brains = fakeBrains({ default: [] })
    await withServer(async base => {
      const res = await fetch(`${base}/brain/query?q=hi&workspace=all`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { workspace: string }
      expect(body.workspace).toBe("all")
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
