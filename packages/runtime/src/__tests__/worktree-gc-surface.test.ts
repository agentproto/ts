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

describe("worktree_gc — MCP tool", () => {
  async function harness(runWorktreeGc?: WorktreeGcRunner) {
    const registry = createSessionsRegistry({ persist: false })
    const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
    registerSessionTools(server, {
      workspace: process.cwd(),
      registry,
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
})
