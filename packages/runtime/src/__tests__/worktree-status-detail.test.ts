/**
 * The worktree-status detail a session header needs, end to end at the
 * runtime seam: the view carries dirty / ahead-behind / base / PR url, a
 * session's own worktree can be read alone (`worktree_status { sessionId }`,
 * `GET /worktrees?sessionId=`), and the descriptor records `mainRepoPath` and
 * the effective `commandSandbox`.
 *
 * The worktree fixture builds git's on-disk layout directly (same approach
 * as `worktree-identity.test.ts`): that layout is what
 * `resolveWorktreeIdentity` reads, so no git binary is needed.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { startHttpServer } from "../http-server.js"
import { registerSessionTools } from "../session-tools.js"
import { resolveEffectiveCommandSandbox } from "../session-spawn.js"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import {
  sessionWorktreeScope,
  toWorktreeStatusView,
  type WorktreeStatusListOptions,
  type WorktreeStatusView,
} from "../worktree-status.js"

const idleAgent = (): AgentSessionLike => ({
  sessionId: "fake",
  async *send() {
    yield { kind: "turn-end", reason: "completed" }
  },
  async cancel() {},
  async close() {},
})

const entry = (overrides: Record<string, unknown> = {}) => ({
  path: "/tmp/wt/foo",
  branch: "wt/foo",
  head: "abc",
  class: "hold",
  reclaimable: false,
  tree: { state: "clean" },
  base: { ref: "origin/main", ahead: 3, behind: 1 },
  integration: { state: "open", pr: 42 },
  liveness: { state: "idle", sessions: [] },
  provenance: { sessions: [] },
  ...overrides,
})

describe("toWorktreeStatusView — the detail fields", () => {
  it("reports a clean tree as not dirty, with no change counts", () => {
    const view = toWorktreeStatusView(entry())
    expect(view.dirty).toBe(false)
    expect(view).not.toHaveProperty("changes")
  })

  it("surfaces the dirty flag and per-kind counts the tree axis computed", () => {
    const view = toWorktreeStatusView(
      entry({
        tree: { state: "dirty", modified: 2, staged: 1, untracked: 4, newestMtimeMs: 1 },
      }),
    )
    expect(view.dirty).toBe(true)
    expect(view.changes).toEqual({ modified: 2, staged: 1, untracked: 4 })
  })

  it("passes ahead/behind and the base ref through, null when unresolved", () => {
    expect(toWorktreeStatusView(entry()).base).toEqual({
      ref: "origin/main",
      ahead: 3,
      behind: 1,
    })
    expect(toWorktreeStatusView(entry({ base: null })).base).toBeNull()
  })

  it("keeps the PR number for merged/partial too and adds the url when the host can build one", () => {
    const prUrl = (n: number) => `https://github.com/o/r/pull/${n}`
    expect(toWorktreeStatusView(entry(), { prUrl }).pr).toEqual({
      state: "open",
      number: 42,
      url: "https://github.com/o/r/pull/42",
    })
    expect(
      toWorktreeStatusView(
        entry({ integration: { state: "merged", via: "squash", pr: 7, offline: false } }),
        { prUrl },
      ).pr,
    ).toEqual({ state: "merged", number: 7, url: "https://github.com/o/r/pull/7" })
    expect(
      toWorktreeStatusView(
        entry({ integration: { state: "partial", pr: 8, aheadBy: 2, offline: false } }),
      ).pr,
    ).toEqual({ state: "partial", number: 8 })
    // No PR matched: no number, no url, whatever the builder says.
    expect(
      toWorktreeStatusView(entry({ integration: { state: "fresh" } }), { prUrl }).pr,
    ).toEqual({ state: "fresh" })
  })
})

describe("sessionWorktreeScope", () => {
  it("targets the main checkout when known, else the worktree itself", () => {
    expect(sessionWorktreeScope({ worktreePath: "/w/a", mainRepoPath: "/repo" })).toEqual({
      repoRoot: "/repo",
      worktreePath: "/w/a",
    })
    expect(sessionWorktreeScope({ worktreePath: "/w/a" })).toEqual({
      repoRoot: "/w/a",
      worktreePath: "/w/a",
    })
    expect(sessionWorktreeScope({})).toBeNull()
  })
})

describe("per-session worktree lookup + descriptor fields", () => {
  let base: string
  let tree: string
  let plainDir: string

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "wt-status-detail-"))
    // Main checkout (`.git` a directory) + one linked worktree whose admin
    // dir carries git's `gitdir` back-pointer and a `commondir`.
    mkdirSync(join(base, "repo", ".git"), { recursive: true })
    const admin = join(base, "repo", ".git", "worktrees", "feat")
    tree = join(base, "trees", "feat")
    mkdirSync(admin, { recursive: true })
    mkdirSync(join(tree, "pkg"), { recursive: true })
    writeFileSync(join(admin, "gitdir"), `${join(tree, ".git")}\n`)
    writeFileSync(join(admin, "commondir"), "../..\n")
    writeFileSync(join(tree, ".git"), `gitdir: ${admin}\n`)
    plainDir = join(base, "plain")
    mkdirSync(plainDir)
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  const VIEW: WorktreeStatusView = {
    path: "",
    branch: "wt/feat",
    class: "hold",
    reclaimable: false,
    dirty: true,
    changes: { modified: 1, staged: 0, untracked: 0 },
    base: { ref: "origin/main", ahead: 2, behind: 0 },
    pr: { state: "open", number: 9, url: "https://github.com/o/r/pull/9" },
    sessions: [],
    liveness: { state: "sessions", sessionCount: 1 },
  }

  function registryWithSessions() {
    const registry = createSessionsRegistry({ persist: false })
    const inWorktree = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: join(tree, "pkg"),
      agentSession: idleAgent(),
      adapterSlug: "fake",
      label: "in-worktree",
      commandSandbox: "workspace",
    })
    const plain = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: plainDir,
      agentSession: idleAgent(),
      adapterSlug: "fake",
      label: "plain",
    })
    return { registry, inWorktree, plain }
  }

  it("records mainRepoPath and the effective commandSandbox on the descriptor and its summary", () => {
    const { registry, inWorktree, plain } = registryWithSessions()
    try {
      expect(inWorktree.worktreePath).toBe(tree)
      expect(inWorktree.mainRepoPath).toBe(join(base, "repo"))
      expect(inWorktree.commandSandbox).toBe("workspace")
      expect(plain.worktreePath).toBeUndefined()
      expect(plain.mainRepoPath).toBeUndefined()
      expect(plain.commandSandbox).toBeUndefined()
      const summary = registry.listSummaries().summaries.find(s => s.id === inWorktree.id)
      expect(summary).toMatchObject({
        worktreePath: tree,
        mainRepoPath: join(base, "repo"),
        commandSandbox: "workspace",
      })
    } finally {
      registry.shutdown()
    }
  })

  it("worktree_status { sessionId } lists only that session's worktree, against its main checkout", async () => {
    const { registry, inWorktree, plain } = registryWithSessions()
    const calls: Array<[string, WorktreeStatusListOptions | undefined]> = []
    const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
    registerSessionTools(server, {
      workspace: process.cwd(),
      registry,
      listWorktreeStatuses: async (repoRoot, options) => {
        calls.push([repoRoot, options])
        return [{ ...VIEW, path: tree }]
      },
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "test", version: "0.0.1" })
    await client.connect(clientTransport)
    const call = async (args: Record<string, unknown>) =>
      (await client.callTool({ name: "worktree_status", arguments: args })) as {
        isError?: boolean
        content: Array<{ text: string }>
      }
    try {
      const own = JSON.parse((await call({ sessionId: inWorktree.id })).content[0]!.text) as {
        worktrees: Array<Record<string, unknown>>
      }
      expect(calls).toEqual([[join(base, "repo"), { paths: [tree] }]])
      // Compact rows carry the new detail.
      expect(own.worktrees).toEqual([
        {
          path: tree,
          branch: "wt/feat",
          class: "hold",
          reclaimable: false,
          dirty: true,
          changes: { modified: 1, staged: 0, untracked: 0 },
          base: { ref: "origin/main", ahead: 2, behind: 0 },
          pr: { state: "open", number: 9, url: "https://github.com/o/r/pull/9" },
          liveness: { state: "sessions", sessionCount: 1 },
        },
      ])

      // A session outside any worktree reads as an empty list without
      // touching the lister.
      const none = JSON.parse((await call({ sessionId: plain.id })).content[0]!.text) as {
        worktrees: unknown[]
      }
      expect(none.worktrees).toEqual([])
      expect(calls).toHaveLength(1)

      const missing = await call({ sessionId: "sess_nope" })
      expect(missing.isError).toBe(true)
      expect(missing.content[0]!.text).toContain('no session "sess_nope"')
    } finally {
      await client.close()
      registry.shutdown()
    }
  })

  it("GET /worktrees?sessionId= is the transport twin", async () => {
    const { registry, inWorktree, plain } = registryWithSessions()
    const calls: Array<[string, WorktreeStatusListOptions | undefined]> = []
    const port = await new Promise<number>((resolve, reject) => {
      const srv = createServer()
      srv.once("error", reject)
      srv.listen(0, "127.0.0.1", () => {
        const p = (srv.address() as AddressInfo).port
        srv.close(() => resolve(p))
      })
    })
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () =>
        (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
      conversations: {
        async open() {},
        async appendTurn() {},
        async read() {
          return { meta: {} as never, turns: [] }
        },
        async list() {
          return []
        },
        pathFor: (id: string) => id,
      } as ConversationStore,
      events: createRuntimeEvents(),
      heartbeat: { start() {}, stop() {}, async fireNow() {} } as HeartbeatRunner,
      meta: { workspace: process.cwd(), registered: [] },
      sessions: registry,
      listWorktreeStatuses: async (repoRoot, options) => {
        calls.push([repoRoot, options])
        return [{ ...VIEW, path: tree }]
      },
    })
    const get = (qs: string) => fetch(`http://127.0.0.1:${port}/worktrees?${qs}`)
    try {
      const res = await get(`sessionId=${inWorktree.id}`)
      expect(res.status).toBe(200)
      expect(((await res.json()) as { worktrees: WorktreeStatusView[] }).worktrees[0]).toMatchObject({
        path: tree,
        dirty: true,
        base: { ahead: 2, behind: 0 },
        pr: { url: "https://github.com/o/r/pull/9" },
      })
      expect(calls).toEqual([[join(base, "repo"), { paths: [tree] }]])

      const plainRes = await get(`sessionId=${plain.id}`)
      expect(await plainRes.json()).toEqual({ worktrees: [] })
      expect((await get("sessionId=sess_nope")).status).toBe(404)
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })
})

describe("resolveEffectiveCommandSandbox", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmd-sandbox-echo-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("is undefined when nobody engaged the axis", async () => {
    await expect(resolveEffectiveCommandSandbox(undefined, dir)).resolves.toBeUndefined()
  })

  it("falls back to the workspace's adapterSpawn.mode, and an explicit request wins", async () => {
    mkdirSync(join(dir, ".agentproto"))
    writeFileSync(
      join(dir, ".agentproto", "command-sandbox.json"),
      JSON.stringify({ adapterSpawn: { mode: "strict" } }),
    )
    await expect(resolveEffectiveCommandSandbox(undefined, dir)).resolves.toBe("strict")
    await expect(resolveEffectiveCommandSandbox("off", dir)).resolves.toBe("off")
  })
})
