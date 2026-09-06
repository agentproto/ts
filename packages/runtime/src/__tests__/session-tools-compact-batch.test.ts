/**
 * ToolTransformer migration batch — session-tools.ts remainder.
 *
 * For every tool migrated off the raw `server.tool(...)` path onto
 * defineTool + implementTool + toMcpTool + catchErrors()/paginated():
 *  - the DEFAULT output is the compact projection (small),
 *  - `full: true` (or `compact: false`) restores the old verbose shape,
 *  - `fields` still filters per-item keys,
 *  - pagination (limit/cursor) behavior is unchanged (page envelope,
 *    cursor walk, total).
 * Error results collapse onto the canonical catchErrors() shape.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerSessionTools } from "../session-tools.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type PtyFactory,
  type SessionsRegistry,
} from "../sessions.js"
import { McpProxyRegistry, type ProxyToolDescriptor } from "../mcp-proxy.js"
import { saveImportedMcps } from "../mcp-imports.js"
import type { DiscoveredMcp } from "../mcp-discovery.js"
import type { WorktreeStatusLister, WorktreeStatusView } from "../worktree-status.js"

vi.mock("../mcp-discovery.js", () => ({
  discoverMcps: async (): Promise<DiscoveredMcp[]> => [
    {
      id: "claude-code:global:chrome-devtools",
      source: "claude-code",
      scope: "global",
      name: "chrome-devtools",
      type: "stdio",
      command: "npx",
      args: ["chrome-devtools-mcp"],
      env: { TOKEN: "secret" },
    },
    {
      id: "cursor:global:github",
      source: "cursor",
      scope: "global",
      name: "github",
      type: "http",
      url: "https://mcp.example.test/github",
      headers: { Authorization: "secret" },
    },
  ],
}))

const fakePtyFactory: PtyFactory = () => ({
  pid: 4242,
  write: () => {},
  resize: () => {},
  kill: () => {},
  onData: () => {},
  onExit: () => {},
})

let acpCounter = 0
function fakeAgentSession(prefix: string): AgentSessionLike {
  return {
    sessionId: `${prefix}_${acpCounter++}`,
    async *send(): AsyncIterable<never> {
      await new Promise(() => {})
    },
    async cancel() {},
    async close() {},
  }
}

function textOf(result: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (result as any).content[0]?.text ?? "{}"
}

function isErrorOf(result: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (result as any).isError === true
}

function parse<T = Record<string, unknown>>(result: unknown): T {
  return JSON.parse(textOf(result)) as T
}

async function buildHarness(opts: {
  registry?: SessionsRegistry
  mcpProxy?: McpProxyRegistry
  listWorktreeStatuses?: WorktreeStatusLister
}): Promise<{ client: Client; close: () => Promise<void> }> {
  const registry = opts.registry ?? createSessionsRegistry({ persist: false })
  const server = new McpServer({ name: "compact-batch-test", version: "0" })
  registerSessionTools(server, {
    registry,
    workspace: process.cwd(),
    ...(opts.mcpProxy ? { mcpProxy: opts.mcpProxy } : {}),
    ...(opts.listWorktreeStatuses
      ? { listWorktreeStatuses: opts.listWorktreeStatuses }
      : {}),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "compact-batch-client", version: "0" })
  await client.connect(clientTransport)
  return { client, close: () => client.close() }
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  return client.callTool({ name, arguments: args })
}

/** Walk pages of `limit` until nextCursor is absent; return the union. */
async function walk<T>(
  client: Client,
  tool: string,
  key: string,
  limit: number,
  extraArgs: Record<string, unknown> = {},
): Promise<T[]> {
  const union: T[] = []
  let cursor: string | undefined
  do {
    const page = parse<{ items: T[]; nextCursor?: string; total: number }>(
      await call(client, tool, {
        limit,
        ...(cursor ? { cursor } : {}),
        ...extraArgs,
      }),
    )
    union.push(...page.items)
    cursor = page.nextCursor
    expect(page.total).toBeGreaterThan(0)
  } while (cursor)
  return union
}

const WORKTREE_VIEWS: WorktreeStatusView[] = [
  {
    path: "/tmp/wt/one",
    branch: "wt/one",
    class: "hold",
    reclaimable: false,
    pr: { state: "open", number: 7 },
    sessions: [{ id: "s1", status: "running", startedAt: "2026-07-20T10:00:00Z" }],
    liveness: { state: "sessions", sessionCount: 1 },
  },
  {
    path: "/tmp/wt/two",
    branch: "wt/two",
    class: "reclaim",
    reclaimable: true,
    pr: null,
    sessions: [],
    liveness: { state: "idle", sessionCount: 0 },
  },
]

const PROXY_TOOLS: ProxyToolDescriptor[] = [
  {
    name: "navigate_page",
    description: "Navigate to a URL.",
    inputSchema: { type: "object", properties: { url: { type: "string" } } },
  },
  {
    name: "take_screenshot",
    description: "Screenshot the page.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "click",
    description: "Click an element.",
    inputSchema: { type: "object", properties: { uid: { type: "string" } } },
  },
]

class OkProxy extends McpProxyRegistry {
  override async listTools(): Promise<{ ok: true; tools: ProxyToolDescriptor[] }> {
    return { ok: true, tools: PROXY_TOOLS }
  }
}

class FailingProxy extends McpProxyRegistry {
  override async listTools(): Promise<{ ok: false; error: string }> {
    return { ok: false, error: "connect ECONNREFUSED" }
  }
}

let home: string
let prevHome: string | undefined
let workspace: string
let registry: SessionsRegistry

beforeEach(async () => {
  prevHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-compact-batch-"))
  process.env.HOME = home
  workspace = mkdtempSync(join(tmpdir(), "compact-batch-ws-"))
  registry = createSessionsRegistry({
    persist: false,
    spawnPty: fakePtyFactory,
  })
})

afterEach(() => {
  registry.shutdown()
  rmSync(workspace, { recursive: true, force: true })
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  return rm(home, { recursive: true, force: true })
})

describe("terminal_sessions_list — compact default / full / fields / pagination", () => {
  it("default rows are compact; full:true restores the descriptor; fields filters", async () => {
    const { client, close } = await buildHarness({ registry })
    registry.spawnPty({
      workspaceSlug: "default",
      cwd: workspace,
      argv: ["bash"],
      cols: 80,
      rows: 24,
    })
    try {
      const def = parse<{ sessions: Array<Record<string, unknown>> }>(
        await call(client, "terminal_sessions_list"),
      )
      expect(def.sessions).toHaveLength(1)
      const row = def.sessions[0]!
      expect(row).toMatchObject({ id: expect.any(String), kind: "terminal", status: "running" })
      expect(row).not.toHaveProperty("pid")
      expect(row).not.toHaveProperty("argv")
      expect(row).not.toHaveProperty("workspaceSlug")

      const full = parse<{ sessions: Array<Record<string, unknown>> }>(
        await call(client, "terminal_sessions_list", { full: true }),
      )
      expect(full.sessions[0]).toMatchObject({ pid: 4242, workspaceSlug: "default" })

      const fields = parse<{ items: Array<Record<string, unknown>> }>(
        await call(client, "terminal_sessions_list", {
          limit: 1,
          full: true,
          fields: ["id", "status"],
        }),
      )
      expect(Object.keys(fields.items[0] ?? {}).sort()).toEqual(["id", "status"])
    } finally {
      await close()
    }
  })

  it("page-walk union equals the unpaginated list", async () => {
    const { client, close } = await buildHarness({ registry })
    for (let i = 0; i < 4; i++) {
      registry.spawnPty({
        workspaceSlug: "default",
        cwd: workspace,
        argv: ["bash"],
        cols: 80,
        rows: 24,
      })
    }
    try {
      const unpaginated = parse<{ sessions: Array<{ id: string }> }>(
        await call(client, "terminal_sessions_list"),
      )
      const union = await walk<{ id: string }>(
        client,
        "terminal_sessions_list",
        "sessions",
        2,
      )
      expect(union.map(s => s.id)).toEqual(unpaginated.sessions.map(s => s.id))
    } finally {
      await close()
    }
  })
})

describe("command_list — compact default (provenance kept) / full / fields / pagination", () => {
  it("default rows are compact but keep origin/callerSessionId; full:true restores the descriptor", async () => {
    const { client, close } = await buildHarness({ registry })
    registry.recordCommand({
      workspaceSlug: "default",
      cwd: workspace,
      command: "echo",
      args: ["hi"],
      exitCode: 0,
      signal: null,
      durationMs: 1,
      stdout: "hi\n",
      stderr: "",
      origin: "cron",
      callerSessionId: "sess_deadbeef",
    })
    try {
      const def = parse<{ sessions: Array<Record<string, unknown>> }>(
        await call(client, "command_list"),
      )
      const row = def.sessions[0]!
      expect(row).toMatchObject({ kind: "command", origin: "cron", callerSessionId: "sess_deadbeef" })
      expect(row).not.toHaveProperty("stdout")
      expect(row).not.toHaveProperty("workspaceSlug")

      const full = parse<{ sessions: Array<Record<string, unknown>> }>(
        await call(client, "command_list", { full: true }),
      )
      expect(full.sessions[0]).toMatchObject({
        workspaceSlug: "default",
        command: "echo hi",
      })

      const fields = parse<{ items: Array<Record<string, unknown>> }>(
        await call(client, "command_list", {
          limit: 1,
          full: true,
          fields: ["id", "exitCode"],
        }),
      )
      expect(Object.keys(fields.items[0] ?? {}).sort()).toEqual(["exitCode", "id"])
    } finally {
      await close()
    }
  })

  it("page-walk union equals the unpaginated list", async () => {
    const { client, close } = await buildHarness({ registry })
    for (let i = 0; i < 3; i++) {
      registry.recordCommand({
        workspaceSlug: "default",
        cwd: workspace,
        command: `cmd-${i}`,
        args: [],
        exitCode: 0,
        signal: null,
        durationMs: 1,
        stdout: "",
        stderr: "",
      })
    }
    try {
      const unpaginated = parse<{ sessions: Array<{ id: string }> }>(
        await call(client, "command_list"),
      )
      const union = await walk<{ id: string }>(client, "command_list", "sessions", 2)
      expect(union.map(s => s.id)).toEqual(unpaginated.sessions.map(s => s.id))
    } finally {
      await close()
    }
  })
})

describe("mcp_discovered_list — compact default / full / fields / pagination", () => {
  it("default entries drop spawn details + secrets; full:true restores them", async () => {
    const { client, close } = await buildHarness({ registry })
    try {
      const def = parse<{ mcps: Array<Record<string, unknown>> }>(
        await call(client, "mcp_discovered_list"),
      )
      expect(def.mcps.map(m => m.id)).toEqual([
        "claude-code:global:chrome-devtools",
        "cursor:global:github",
      ])
      expect(def.mcps[0]).toMatchObject({ source: "claude-code", name: "chrome-devtools", type: "stdio" })
      expect(JSON.stringify(def)).not.toContain("secret")
      expect(def.mcps[0]).not.toHaveProperty("command")
      expect(def.mcps[1]).not.toHaveProperty("url")

      const full = parse<{ mcps: Array<Record<string, unknown>> }>(
        await call(client, "mcp_discovered_list", { full: true }),
      )
      expect(full.mcps[0]).toMatchObject({ command: "npx", env: { TOKEN: "secret" } })
      expect(full.mcps[1]).toMatchObject({ url: "https://mcp.example.test/github" })

      const fields = parse<{ items: Array<Record<string, unknown>> }>(
        await call(client, "mcp_discovered_list", {
          limit: 1,
          full: true,
          fields: ["id", "source"],
        }),
      )
      expect(Object.keys(fields.items[0] ?? {}).sort()).toEqual(["id", "source"])
    } finally {
      await close()
    }
  })

  it("page-walk union equals the unpaginated list", async () => {
    const { client, close } = await buildHarness({ registry })
    try {
      const unpaginated = parse<{ mcps: Array<{ id: string }> }>(
        await call(client, "mcp_discovered_list"),
      )
      const union = await walk<{ id: string }>(client, "mcp_discovered_list", "mcps", 1)
      expect(union.map(m => m.id)).toEqual(unpaginated.mcps.map(m => m.id))
    } finally {
      await close()
    }
  })
})

describe("mcp_imported_list — compact default / full / fields / pagination", () => {
  it("default entries are the compact projection; full:true includes the snapshot", async () => {
    await saveImportedMcps({
      version: 1,
      imports: [
        {
          id: "claude-code:global:chrome-devtools",
          alias: "chrome",
          addedAt: "2026-07-22T10:00:00.000Z",
          snapshot: {
            id: "claude-code:global:chrome-devtools",
            source: "claude-code",
            scope: "global",
            name: "chrome-devtools",
            type: "stdio",
          },
        },
      ],
    })
    const { client, close } = await buildHarness({ registry })
    try {
      const def = parse<{ imports: Array<Record<string, unknown>> }>(
        await call(client, "mcp_imported_list"),
      )
      expect(def.imports[0]).toEqual({
        id: "claude-code:global:chrome-devtools",
        alias: "chrome",
        addedAt: "2026-07-22T10:00:00.000Z",
        source: "claude-code",
        name: "chrome-devtools",
        type: "stdio",
      })
      expect(JSON.stringify(def)).not.toContain("snapshot")

      const full = parse<{ imports: Array<Record<string, unknown>> }>(
        await call(client, "mcp_imported_list", { full: true }),
      )
      expect(full.imports[0]).toMatchObject({
        snapshot: { id: "claude-code:global:chrome-devtools", type: "stdio" },
      })

      const fields = parse<{ items: Array<Record<string, unknown>> }>(
        await call(client, "mcp_imported_list", {
          limit: 1,
          full: true,
          fields: ["id", "alias"],
        }),
      )
      expect(Object.keys(fields.items[0] ?? {}).sort()).toEqual(["alias", "id"])
    } finally {
      await close()
    }
  })

  it("page-walk union equals the unpaginated list", async () => {
    await saveImportedMcps({
      version: 1,
      imports: [
        {
          id: "a:global:x",
          alias: "x",
          addedAt: "2026-07-22T10:00:00.000Z",
          snapshot: { id: "a:global:x", source: "cursor", scope: "global", name: "x", type: "http" },
        },
        {
          id: "b:global:y",
          alias: "y",
          addedAt: "2026-07-22T10:01:00.000Z",
          snapshot: { id: "b:global:y", source: "goose", scope: "global", name: "y", type: "stdio" },
        },
        {
          id: "c:global:z",
          alias: "z",
          addedAt: "2026-07-22T10:02:00.000Z",
          snapshot: { id: "c:global:z", source: "goose", scope: "global", name: "z", type: "stdio" },
        },
      ],
    })
    const { client, close } = await buildHarness({ registry })
    try {
      const unpaginated = parse<{ imports: Array<{ id: string }> }>(
        await call(client, "mcp_imported_list"),
      )
      const union = await walk<{ id: string }>(client, "mcp_imported_list", "imports", 2)
      expect(union.map(e => e.id)).toEqual(unpaginated.imports.map(e => e.id))
    } finally {
      await close()
    }
  })
})

describe("mcp_imported_tool_list — compact default / full / fields / pagination / errors", () => {
  it("default rows are name+description; full:true restores inputSchema; fields filters", async () => {
    const { client, close } = await buildHarness({
      registry,
      mcpProxy: new OkProxy(),
    })
    try {
      const def = parse<{ tools: Array<Record<string, unknown>> }>(
        await call(client, "mcp_imported_tool_list", { alias: "chrome-devtools" }),
      )
      expect(def.tools.map(t => t.name)).toEqual(["navigate_page", "take_screenshot", "click"])
      expect(def.tools[0]).toEqual({ name: "navigate_page", description: "Navigate to a URL." })
      expect(JSON.stringify(def)).not.toContain("inputSchema")

      const full = parse<{ tools: Array<Record<string, unknown>> }>(
        await call(client, "mcp_imported_tool_list", { alias: "chrome-devtools", full: true }),
      )
      expect(full.tools[0]).toMatchObject({
        inputSchema: { type: "object", properties: { url: { type: "string" } } },
      })

      const fields = parse<{ items: Array<Record<string, unknown>> }>(
        await call(client, "mcp_imported_tool_list", {
          alias: "chrome-devtools",
          limit: 1,
          full: true,
          fields: ["name"],
        }),
      )
      expect(fields.items[0]).toEqual({ name: "navigate_page" })
    } finally {
      await close()
    }
  })

  it("page-walk union equals the unpaginated list", async () => {
    const { client, close } = await buildHarness({
      registry,
      mcpProxy: new OkProxy(),
    })
    try {
      const unpaginated = parse<{ tools: Array<{ name: string }> }>(
        await call(client, "mcp_imported_tool_list", { alias: "chrome-devtools" }),
      )
      const union = await walk<{ name: string }>(
        client,
        "mcp_imported_tool_list",
        "tools",
        2,
        { alias: "chrome-devtools" },
      )
      expect(union.map(t => t.name)).toEqual(unpaginated.tools.map(t => t.name))
    } finally {
      await close()
    }
  })

  it("upstream listTools failure surfaces as the canonical error result", async () => {
    const { client, close } = await buildHarness({
      registry,
      mcpProxy: new FailingProxy(),
    })
    try {
      const result = await call(client, "mcp_imported_tool_list", {
        alias: "chrome-devtools",
      })
      expect(isErrorOf(result)).toBe(true)
      expect(textOf(result)).toContain("connect ECONNREFUSED")
    } finally {
      await close()
    }
  })
})

describe("session_queue_list — compact default / full / fields / pagination / errors", () => {
  async function queueHarness(): Promise<{
    client: Client
    sessionId: string
    close: () => Promise<void>
  }> {
    const agent: AgentSessionLike = {
      sessionId: "compact-batch-queue",
      async *send() {
        await new Promise(() => {})
      },
      async cancel() {},
      async close() {},
    }
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: agent,
      adapterSlug: "fake",
    })
    const firstPromise = registry.sendPrompt(desc.id, "first")
    await Promise.resolve()
    await registry.enqueuePrompt(desc.id, "s1", { queue: true })
    await registry.enqueuePrompt(desc.id, "s2", { queue: true })
    await registry.enqueuePrompt(desc.id, "s3", { queue: true })
    void firstPromise.catch(() => undefined)
    const { client, close } = await buildHarness({ registry })
    return { client, sessionId: desc.id, close }
  }

  it("default rows drop queuedAt; full:true restores it; fields filters", async () => {
    const { client, sessionId, close } = await queueHarness()
    try {
      const def = parse<{ queue: Array<Record<string, unknown>> }>(
        await call(client, "session_queue_list", { sessionId }),
      )
      expect(def.queue.map(q => q.preview)).toEqual(["s1", "s2", "s3"])
      expect(def.queue[0]).toMatchObject({ position: 0, origin: "user" })
      expect(JSON.stringify(def)).not.toContain("queuedAt")

      const full = parse<{ queue: Array<Record<string, unknown>> }>(
        await call(client, "session_queue_list", { sessionId, full: true }),
      )
      expect(full.queue[0]).toHaveProperty("queuedAt")

      const fields = parse<{ items: Array<Record<string, unknown>> }>(
        await call(client, "session_queue_list", {
          sessionId,
          limit: 1,
          full: true,
          fields: ["id", "position"],
        }),
      )
      expect(Object.keys(fields.items[0] ?? {}).sort()).toEqual(["id", "position"])
    } finally {
      await close()
    }
  })

  it("page-walk union equals the unpaginated queue", async () => {
    const { client, sessionId, close } = await queueHarness()
    try {
      const unpaginated = parse<{ queue: Array<{ id: string }> }>(
        await call(client, "session_queue_list", { sessionId }),
      )
      const union = await walk<{ id: string }>(
        client,
        "session_queue_list",
        "queue",
        2,
        { sessionId },
      )
      expect(union.map(q => q.id)).toEqual(unpaginated.queue.map(q => q.id))
    } finally {
      await close()
    }
  })

  it("unknown session surfaces as the canonical error result", async () => {
    const { client, close } = await buildHarness({ registry })
    try {
      const result = await call(client, "session_queue_list", {
        sessionId: "nope",
      })
      expect(isErrorOf(result)).toBe(true)
      expect(textOf(result)).toContain('no session "nope" found')
    } finally {
      await close()
    }
  })
})

describe("worktree_status — compact default / full / fields / pagination / errors", () => {
  const lister: WorktreeStatusLister = async () => WORKTREE_VIEWS

  it("default rows drop the session roster; full:true restores it; fields filters", async () => {
    const { client, close } = await buildHarness({ registry, listWorktreeStatuses: lister })
    try {
      const def = parse<{ worktrees: Array<Record<string, unknown>> }>(
        await call(client, "worktree_status", { repoRoot: "/repo" }),
      )
      expect(def.worktrees.map(w => w.path)).toEqual(["/tmp/wt/one", "/tmp/wt/two"])
      expect(def.worktrees[0]).toMatchObject({
        class: "hold",
        pr: { state: "open", number: 7 },
        liveness: { state: "sessions", sessionCount: 1 },
      })
      expect(def.worktrees[0]).not.toHaveProperty("sessions")
      expect(def.worktrees[1]).not.toHaveProperty("sessions")

      const full = parse<{ worktrees: Array<Record<string, unknown>> }>(
        await call(client, "worktree_status", { repoRoot: "/repo", full: true }),
      )
      expect(full.worktrees).toEqual(WORKTREE_VIEWS)

      const fields = parse<{ items: Array<Record<string, unknown>> }>(
        await call(client, "worktree_status", {
          repoRoot: "/repo",
          limit: 1,
          full: true,
          fields: ["path"],
        }),
      )
      expect(fields.items[0]).toEqual({ path: "/tmp/wt/one" })
    } finally {
      await close()
    }
  })

  it("page-walk union equals the unpaginated list", async () => {
    const { client, close } = await buildHarness({ registry, listWorktreeStatuses: lister })
    try {
      const unpaginated = parse<{ worktrees: Array<{ path: string }> }>(
        await call(client, "worktree_status", { repoRoot: "/repo" }),
      )
      const union = await walk<{ path: string }>(
        client,
        "worktree_status",
        "worktrees",
        1,
        { repoRoot: "/repo" },
      )
      expect(union.map(w => w.path)).toEqual(unpaginated.worktrees.map(w => w.path))
    } finally {
      await close()
    }
  })

  it("no lister wired surfaces as the canonical error result", async () => {
    const { client, close } = await buildHarness({ registry })
    try {
      const result = await call(client, "worktree_status", {})
      expect(isErrorOf(result)).toBe(true)
      expect(textOf(result)).toContain("worktree_status is not enabled")
    } finally {
      await close()
    }
  })
})
