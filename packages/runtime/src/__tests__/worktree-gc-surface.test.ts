/**
 * Surface wiring for the worktree-`gc` transport surface — `POST /worktrees/gc`
 * and the `worktree_gc` MCP tool. Both are thin shells over an injected
 * `runWorktreeGc` port (the transport twin of `worktree_status` /
 * `listWorktreeStatuses`): this file checks that the params reach the runner,
 * that a bare call is a DRY RUN, that `apply:true` executes, that string
 * booleans coerce, and that the "not enabled" fallback fires — never the
 * plan/apply engine itself, which lives in `@agentproto/worktree`.
 */

import { describe, it, expect } from "vitest"
import { createServer } from "node:http"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { startHttpServer, type RuntimeHttpServerHandle } from "../http-server.js"
import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import type {
  WorktreeGcRunner,
  WorktreeGcRunInput,
  WorktreeGcResult,
} from "../worktree-gc.js"

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

function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: "acp_gc_surface_test",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<never> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

async function mcpServerFactory() {
  return (await createMcpServer({ specs: [], name: "main", version: "0" })).server
}

const PLAN_RESULT: WorktreeGcResult = {
  mode: "plan",
  plan: [
    {
      path: "/tmp/wt/reclaimable",
      branch: "wt/reclaimable",
      head: "abc123",
      class: "reclaim",
      tree: "clean",
      integration: { state: "merged", pr: 42 },
      liveness: { state: "idle", sessionCount: 0 },
    },
    {
      path: "/tmp/wt/open-pr",
      branch: "wt/open-pr",
      head: "def456",
      class: "hold",
      tree: "clean",
      integration: { state: "open", pr: 7 },
      liveness: { state: "sessions", sessionCount: 1 },
    },
  ],
}

const APPLY_RESULT: WorktreeGcResult = {
  mode: "apply",
  outcomes: [
    { path: "/tmp/wt/reclaimable", branch: "wt/reclaimable", result: "reclaimed" },
    { path: "/tmp/wt/open-pr", branch: "wt/open-pr", result: "held" },
  ],
}

/** A runner that records its last input and returns plan-or-apply by `apply`. */
function recordingRunner(): {
  runner: WorktreeGcRunner
  seen: () => WorktreeGcRunInput | undefined
} {
  let last: WorktreeGcRunInput | undefined
  const runner: WorktreeGcRunner = async input => {
    last = input
    return input.apply ? APPLY_RESULT : PLAN_RESULT
  }
  return { runner, seen: () => last }
}

describe("POST /worktrees/gc — HTTP route", () => {
  async function start(
    runWorktreeGc?: WorktreeGcRunner,
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
      ...(runWorktreeGc ? { runWorktreeGc } : {}),
    })
  }

  async function post(http: RuntimeHttpServerHandle, body: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${http.url.split(":").pop()}/worktrees/gc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  it("501 with a clear message when no runner is wired", async () => {
    const http = await start()
    try {
      const res = await post(http, { repoRoot: "/repo" })
      expect(res.status).toBe(501)
      const b = (await res.json()) as { error: string }
      expect(b.error).toBe("worktree_gc_not_configured")
    } finally {
      await http.stop()
    }
  })

  it("dry-run by default: returns the plan and forwards apply=false", async () => {
    const { runner, seen } = recordingRunner()
    const http = await start(runner)
    try {
      const res = await post(http, { repoRoot: "/some/repo" })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(PLAN_RESULT)
      expect(seen()).toEqual({
        repoRoot: "/some/repo",
        apply: false,
        salvageDirty: false,
        includeDetached: false,
      })
    } finally {
      await http.stop()
    }
  })

  it("apply:true returns outcomes and forwards the flags", async () => {
    const { runner, seen } = recordingRunner()
    const http = await start(runner)
    try {
      const res = await post(http, {
        repoRoot: "/repo",
        apply: true,
        salvageDirty: true,
        includeDetached: true,
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(APPLY_RESULT)
      expect(seen()).toEqual({
        repoRoot: "/repo",
        apply: true,
        salvageDirty: true,
        includeDetached: true,
      })
    } finally {
      await http.stop()
    }
  })

  it("coerces string booleans in the body (apply:'true')", async () => {
    const { runner, seen } = recordingRunner()
    const http = await start(runner)
    try {
      const res = await post(http, { repoRoot: "/repo", apply: "true", salvageDirty: "false" })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(APPLY_RESULT)
      expect(seen()).toEqual({
        repoRoot: "/repo",
        apply: true,
        salvageDirty: false,
        includeDetached: false,
      })
    } finally {
      await http.stop()
    }
  })

  it("500 with the message when the runner throws", async () => {
    const runner: WorktreeGcRunner = async () => {
      throw new Error("forge offline")
    }
    const http = await start(runner)
    try {
      const res = await post(http, { repoRoot: "/repo" })
      expect(res.status).toBe(500)
      const b = (await res.json()) as { error: string; message: string }
      expect(b.error).toBe("worktree_gc_failed")
      expect(b.message).toBe("forge offline")
    } finally {
      await http.stop()
    }
  })

  it("protectedPaths carries the cwd of a live session from the wired SessionsRegistry, excluding a killed one", async () => {
    const registry = createSessionsRegistry({ persist: false })
    registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp/wt/live-session-cwd",
      agentSession: fakeAgentSession(),
      adapterSlug: "fake",
    })
    const dying = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp/wt/dead-session-cwd",
      agentSession: fakeAgentSession(),
      adapterSlug: "fake",
    })
    registry.kill(dying.id)

    const { runner, seen } = recordingRunner()
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
      runWorktreeGc: runner,
      sessions: registry,
    })
    try {
      const res = await post(http, { repoRoot: "/repo" })
      expect(res.status).toBe(200)
      expect(seen()?.protectedPaths).toEqual(["/tmp/wt/live-session-cwd"])
    } finally {
      await http.stop()
    }
  })
})

const tmpJobsDir = join(tmpdir(), `wgc-jobs-default-${process.pid}`)

describe("worktree_gc — MCP tool", () => {
  async function harness(runWorktreeGc?: WorktreeGcRunner, worktreeGcJobsDir?: string) {
    const registry = createSessionsRegistry({ persist: false })
    const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
    registerSessionTools(server, {
      workspace: process.cwd(),
      registry,
      worktreeGcJobsDir: worktreeGcJobsDir ?? tmpJobsDir,
      ...(runWorktreeGc ? { runWorktreeGc } : {}),
    })

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "test", version: "0.0.1" })
    await client.connect(clientTransport)
    return { client, close: async () => client.close() }
  }

  function payload(result: unknown): WorktreeGcResult {
    const content = (result as { content: Array<{ text: string }> }).content
    return JSON.parse(content[0]!.text) as WorktreeGcResult
  }

  it("reports 'not enabled' when no runner is wired", async () => {
    const h = await harness()
    try {
      const result = await h.client.callTool({ name: "worktree_gc", arguments: { repoRoot: "/repo" } })
      expect((result as { isError?: boolean }).isError).toBe(true)
      const content = (result as { content: Array<{ text: string }> }).content
      expect(content[0]!.text).toContain("worktree_gc is not enabled")
    } finally {
      await h.close()
    }
  })

  it("dry-run by default: returns the plan and forwards apply=false", async () => {
    const { runner, seen } = recordingRunner()
    const h = await harness(runner)
    try {
      const result = await h.client.callTool({
        name: "worktree_gc",
        arguments: { repoRoot: "/some/repo" },
      })
      expect(payload(result)).toEqual(PLAN_RESULT)
      expect(seen()).toEqual({
        repoRoot: "/some/repo",
        apply: false,
        salvageDirty: false,
        includeDetached: false,
        // The harness's registry has no live sessions — see the
        // "protectedPaths" describe block below for the non-empty case.
        protectedPaths: [],
      })
    } finally {
      await h.close()
    }
  })

  it("apply:true returns outcomes", async () => {
    const { runner, seen } = recordingRunner()
    const h = await harness(runner)
    try {
      const result = await h.client.callTool({
        name: "worktree_gc",
        arguments: { repoRoot: "/repo", apply: true, salvageDirty: true },
      })
      expect(payload(result)).toEqual(APPLY_RESULT)
      expect(seen()).toEqual({
        repoRoot: "/repo",
        apply: true,
        salvageDirty: true,
        includeDetached: false,
        protectedPaths: [],
      })
    } finally {
      await h.close()
    }
  })

  it("coerces mcpBool string args ('true'/'false')", async () => {
    const { runner, seen } = recordingRunner()
    const h = await harness(runner)
    try {
      const result = await h.client.callTool({
        name: "worktree_gc",
        arguments: { repoRoot: "/repo", apply: "true", salvageDirty: "false", includeDetached: "true" },
      })
      expect(payload(result)).toEqual(APPLY_RESULT)
      expect(seen()).toEqual({
        repoRoot: "/repo",
        apply: true,
        salvageDirty: false,
        includeDetached: true,
        protectedPaths: [],
      })
    } finally {
      await h.close()
    }
  })

  it("protectedPaths carries every live (running/starting) session's cwd from the registry, excluding a killed one", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
    const { runner, seen } = recordingRunner()
    registerSessionTools(server, { registry, workspace: process.cwd(), runWorktreeGc: runner })

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "test", version: "0.0.1" })
    await client.connect(clientTransport)

    try {
      registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp/wt/live-session-cwd",
        agentSession: fakeAgentSession(),
        adapterSlug: "fake",
      })
      const dying = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp/wt/dead-session-cwd",
        agentSession: fakeAgentSession(),
        adapterSlug: "fake",
      })
      registry.kill(dying.id)

      await client.callTool({ name: "worktree_gc", arguments: { repoRoot: "/repo" } })
      expect(seen()?.protectedPaths).toEqual(["/tmp/wt/live-session-cwd"])
    } finally {
      await client.close()
    }
  })

  describe("background mode", () => {
    const text = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0]!.text
    const isError = (r: unknown): boolean => (r as { isError?: boolean }).isError === true
    const gated = (): { runner: WorktreeGcRunner; release: (r: WorktreeGcResult) => void } => {
      let release!: (r: WorktreeGcResult) => void
      const gate = new Promise<WorktreeGcResult>(res => {
        release = res
      })
      return { runner: () => gate, release }
    }
    async function pollDone(h: { client: Client }, jobId: string): Promise<{ status: string; resultPath: string; result: unknown }> {
      let view: { status: string; resultPath: string; result: unknown } | undefined
      for (let i = 0; i < 200; i++) {
        view = JSON.parse(text(await h.client.callTool({ name: "worktree_gc_status", arguments: { jobId } })))
        if (view!.status !== "running") break
        await new Promise(res => setTimeout(res, 10))
      }
      return view!
    }

    it("wait:false returns a jobId + followUp; worktree_gc_status goes running → done with the result and a file on disk", async () => {
      const jobsDir = await mkdtemp(join(tmpdir(), "wgc-jobs-"))
      const { runner, release } = gated()
      const h = await harness(runner, jobsDir)
      try {
        const started = JSON.parse(
          text(await h.client.callTool({ name: "worktree_gc", arguments: { repoRoot: "/repo", wait: false } })),
        ) as { jobId: string; status: string; followUp: { tool: string; args: { jobId: string }; pollAfterMs: number; hint: string } }
        expect(started.status).toBe("running")
        expect(started.jobId).toMatch(/^wgc_[0-9a-f]{8}$/)
        expect(started.followUp.tool).toBe("worktree_gc_status")
        expect(started.followUp.args).toEqual({ jobId: started.jobId })
        expect(started.followUp.pollAfterMs).toBe(30000)
        expect(started.followUp.hint).toContain("worktree_gc_status")

        const running = JSON.parse(
          text(await h.client.callTool({ name: "worktree_gc_status", arguments: { jobId: started.jobId } })),
        ) as { status: string; elapsedMs: number }
        expect(running.status).toBe("running")
        expect(running.elapsedMs).toBeGreaterThanOrEqual(0)

        release(PLAN_RESULT)
        const done = await pollDone(h, started.jobId)
        expect(done.status).toBe("done")
        expect(done.result).toEqual(PLAN_RESULT)
        expect(existsSync(done.resultPath)).toBe(true)
        expect(JSON.parse(await readFile(done.resultPath, "utf8"))).toEqual(PLAN_RESULT)
      } finally {
        release(PLAN_RESULT)
        await h.close()
        await rm(jobsDir, { recursive: true, force: true })
      }
    })

    it("a run that outlasts waitMs falls back to the background view; the run still completes", async () => {
      const jobsDir = await mkdtemp(join(tmpdir(), "wgc-jobs-"))
      const { runner, release } = gated()
      const h = await harness(runner, jobsDir)
      try {
        const res = await h.client.callTool({ name: "worktree_gc", arguments: { repoRoot: "/repo", waitMs: 20 } })
        const view = JSON.parse(text(res)) as { jobId: string; status: string }
        expect(view.status).toBe("running")
        release(APPLY_RESULT)
        expect((await pollDone(h, view.jobId)).result).toEqual(APPLY_RESULT)
      } finally {
        release(APPLY_RESULT)
        await h.close()
        await rm(jobsDir, { recursive: true, force: true })
      }
    })

    it("the default wait returns a fast run inline (no jobId)", async () => {
      const { runner } = recordingRunner()
      const h = await harness(runner)
      try {
        const res = await h.client.callTool({ name: "worktree_gc", arguments: { repoRoot: "/repo" } })
        expect(JSON.parse(text(res))).toEqual(PLAN_RESULT)
      } finally {
        await h.close()
      }
    })

    it("a runner failure surfaces inline for a waiting call and via status for a background one", async () => {
      const failing: WorktreeGcRunner = async () => {
        throw new Error("git exploded")
      }
      const h = await harness(failing)
      try {
        const inline = await h.client.callTool({ name: "worktree_gc", arguments: { repoRoot: "/repo" } })
        expect(isError(inline)).toBe(true)
        expect(text(inline)).toContain("worktree_gc failed: git exploded")

        const started = JSON.parse(
          text(await h.client.callTool({ name: "worktree_gc", arguments: { repoRoot: "/repo", wait: false } })),
        ) as { jobId: string }
        const view = await pollDone(h, started.jobId)
        expect(view).toMatchObject({ status: "failed", error: "git exploded" })
      } finally {
        await h.close()
      }
    })

    it("worktree_gc_status falls back to the on-disk result, rejects malformed ids, and reports unknown ids", async () => {
      const jobsDir = await mkdtemp(join(tmpdir(), "wgc-jobs-"))
      await mkdir(jobsDir, { recursive: true })
      await writeFile(join(jobsDir, "wgc_deadbeef.json"), JSON.stringify(APPLY_RESULT))
      const h = await harness(recordingRunner().runner, jobsDir)
      try {
        const disk = await h.client.callTool({ name: "worktree_gc_status", arguments: { jobId: "wgc_deadbeef" } })
        expect(isError(disk)).toBe(false)
        expect(JSON.parse(text(disk))).toMatchObject({ status: "done", result: APPLY_RESULT })

        const bad = await h.client.callTool({ name: "worktree_gc_status", arguments: { jobId: "../x" } })
        expect(isError(bad)).toBe(true)
        expect(text(bad)).toContain("not found (no running job and no result file at")

        const unknown = await h.client.callTool({ name: "worktree_gc_status", arguments: { jobId: "wgc_00000000" } })
        expect(isError(unknown)).toBe(true)
      } finally {
        await h.close()
        await rm(jobsDir, { recursive: true, force: true })
      }
    })
  })
})
