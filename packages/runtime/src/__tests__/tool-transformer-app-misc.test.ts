/**
 * MCP-transport coverage for the app/task/tunnel tool batch migrated onto
 * the ToolTransformer mechanism (defineTool + implementTool + toMcpTool +
 * paginated/catchErrors): for every migrated list tool it proves the
 * DEFAULT output is compact, `full: true` returns the old verbose shape,
 * `fields` filters per item, the legacy default envelope is preserved
 * (bare array / `{boardId, tasks}` / `{appId, dir, entries}` /
 * `{tunnels}`), page-walking covers exactly the unpaginated list, and the
 * pre-existing guard/error replies keep their shape.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerAppTools } from "../app-tools.js"
import { createAppRegistry } from "../app-registry.js"
import { createSessionsRegistry } from "../sessions.js"
import { registerTaskTools } from "../task-tools.js"
import type { TaskCaller, TaskLedger, TaskRecord } from "../task-ledger.js"
import { registerTunnelTools } from "../tunnel-tools.js"
import { TunnelRegistry } from "../tunnel-registry.js"
import { registerAppDataTools } from "../app-data.js"
import { registerAppExternalTools } from "../app-external.js"
import { defineApp } from "@agentproto/app-kit"

function parseToolJson(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}
function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true
}

async function mcpClient(register: (server: McpServer) => void | Promise<void>): Promise<Client> {
  const server = new McpServer({ name: "tt-app-misc-test-server", version: "0.0.0" })
  await register(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "tt-app-misc-test-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

async function pageWalk(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  key: string,
  total: number,
): Promise<any[]> {
  const union: any[] = []
  let cursor: string | undefined
  do {
    const page = parseToolJson(
      await client.callTool({
        name,
        arguments: { ...args, limit: 2, ...(cursor ? { cursor } : {}) },
      }),
    )
    expect(page.total).toBe(total)
    union.push(...page[key])
    cursor = page.nextCursor
  } while (cursor)
  return union
}

// ── tunnel_list ──────────────────────────────────────────────────────

describe("tunnel_list (paginated transformer)", () => {
  let home: string
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "tt-tunnel-"))
    const tunnelsDir = join(home, ".agentproto")
    await mkdir(tunnelsDir, { recursive: true })
    await writeFile(
      join(tunnelsDir, "tunnels.json"),
      JSON.stringify({
        tunnels: [
          {
            id: "t-1",
            provider: "quick",
            targetHost: "127.0.0.1",
            targetPort: 3000,
            publicUrl: "https://a.trycloudflare.com",
            status: "active",
            pid: 111,
            createdAt: "2026-09-01T00:00:00.000Z",
            lastError: "once failed",
            credentialsFile: "/home/u/.cloudflared/creds.json",
          },
          {
            id: "t-2",
            provider: "quick",
            targetHost: "127.0.0.1",
            targetPort: 3001,
            publicUrl: "https://b.trycloudflare.com",
            status: "stopped",
            pid: null,
            createdAt: "2026-09-02T00:00:00.000Z",
            stoppedAt: "2026-09-02T01:00:00.000Z",
          },
          {
            id: "t-3",
            provider: "quick",
            targetHost: "127.0.0.1",
            targetPort: 3002,
            publicUrl: "https://c.trycloudflare.com",
            status: "active",
            pid: 333,
            createdAt: "2026-09-03T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    )
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  async function setup() {
    const registry = new TunnelRegistry({
      persistPath: join(home, ".agentproto", "tunnels.json"),
      workspace: home,
    })
    return mcpClient(server => registerTunnelTools(server, { registry }))
  }

  it("default call is the compact {tunnels} projection; full:true returns the old descriptors", async () => {
    const client = await setup()
    const def = parseToolJson(await client.callTool({ name: "tunnel_list", arguments: {} }))
    expect(Object.keys(def)).toEqual(["tunnels"])
    expect(def.tunnels.map((t: { id: string }) => t.id)).toEqual(["t-1", "t-2", "t-3"])
    expect(def.tunnels[0]).toMatchObject({
      id: "t-1",
      provider: "quick",
      targetPort: 3000,
      publicUrl: "https://a.trycloudflare.com",
      createdAt: "2026-09-01T00:00:00.000Z",
    })
    expect(def.tunnels[0].pid).toBeUndefined()
    expect(def.tunnels[0].lastError).toBeUndefined()
    expect(def.tunnels[0].credentialsFile).toBeUndefined()

    const full = parseToolJson(
      await client.callTool({ name: "tunnel_list", arguments: { full: true } }),
    )
    expect(full.tunnels.map((t: { id: string }) => t.id)).toEqual(["t-1", "t-2", "t-3"])
    expect(full.tunnels[0].pid).toBeDefined()
    expect(full.tunnels[0].lastError).toBe("once failed")
    expect(full.tunnels[0].credentialsFile).toBe("/home/u/.cloudflared/creds.json")
    expect(full.tunnels[1].stoppedAt).toBe("2026-09-02T01:00:00.000Z")
    await client.close()
  })

  it("fields filters per item on the paginated branch; page-walk covers the list exactly", async () => {
    const client = await setup()
    const page = parseToolJson(
      await client.callTool({ name: "tunnel_list", arguments: { limit: 2, fields: ["id", "provider"] } }),
    )
    expect(page.total).toBe(3)
    expect(page.items).toEqual([
      { id: "t-1", provider: "quick" },
      { id: "t-2", provider: "quick" },
    ])

    const union = await pageWalk(client, "tunnel_list", {}, "items", 3)
    expect(union.map((t: { id: string }) => t.id)).toEqual(["t-1", "t-2", "t-3"])
    await client.close()
  })
})

// ── task_list ────────────────────────────────────────────────────────

const T0 = "2026-07-22T10:00:00.000Z"

function taskRecord(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "task_1",
    boardId: "tree:root",
    title: "t",
    status: "pending",
    createdBy: "sup",
    rev: 0,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  }
}

describe("task_list (paginated transformer)", () => {
  function fakeLedger(tasks: TaskRecord[]): TaskLedger {
    return {
      create: () => ({ ok: true, task: tasks[0]! }),
      list: () => tasks,
      get: () => tasks[0]!,
      claim: () => ({ ok: true, task: tasks[0]! }),
      update: () => ({ ok: true, task: tasks[0]! }),
      resolveBoardId: (_caller, explicit) => explicit ?? "ws:default",
      snapshot: () => tasks,
      dispose() {},
    }
  }

  const fullTask = taskRecord({
    description: "long description",
    verify: { command: "pnpm", args: ["test"] } as TaskRecord["verify"],
    meta: { prUrl: "https://example.test/pr/1" },
    sessions: ["sess_1"],
  })

  async function setup(tasks: TaskRecord[], opts: { noLedger?: boolean } = {}) {
    return {
      client: await mcpClient(server =>
        opts.noLedger
          ? registerTaskTools(server, {})
          : registerTaskTools(server, { ledger: fakeLedger(tasks) }),
      ),
    }
  }

  it("default call keeps the {boardId, tasks} envelope with compact tasks; full:true returns old records", async () => {
    const three = [
      taskRecord({ taskId: "task_1" }),
      taskRecord({ taskId: "task_2", title: "second" }),
      taskRecord({ taskId: "task_3", title: "third" }),
    ]
    const { client } = await setup(three)

    const def = parseToolJson(await client.callTool({ name: "task_list", arguments: {} }))
    expect(def.boardId).toBe("ws:default")
    expect(def.tasks.map((t: { taskId: string }) => t.taskId)).toEqual(["task_1", "task_2", "task_3"])
    expect(def.tasks[0]).toMatchObject({
      taskId: "task_1",
      rev: 0,
      title: "t",
      status: "pending",
      boardId: "tree:root",
      createdAt: T0,
      updatedAt: T0,
      hasVerify: false,
    })
    expect(def.tasks[0].description).toBeUndefined()
    expect(def.tasks[0].verify).toBeUndefined()
    expect(def.tasks[0].meta).toBeUndefined()
    expect(def.tasks[0].sessions).toBeUndefined()

    const full = parseToolJson(
      await client.callTool({ name: "task_list", arguments: { full: true } }),
    )
    expect(full.boardId).toBe("ws:default")
    expect(full.tasks).toEqual(three)
    await client.close()
  })

  it("fields filters per item on the paginated branch; page-walk covers the list exactly", async () => {
    const three = [
      taskRecord({ taskId: "task_1" }),
      taskRecord({ taskId: "task_2", title: "second" }),
      taskRecord({ taskId: "task_3", title: "third" }),
    ]
    const { client } = await setup(three)
    const page = parseToolJson(
      await client.callTool({ name: "task_list", arguments: { limit: 2, fields: ["taskId", "status"] } }),
    )
    expect(page.total).toBe(3)
    expect(page.items).toEqual([
      { taskId: "task_1", status: "pending" },
      { taskId: "task_2", status: "pending" },
    ])
    const union = await pageWalk(client, "task_list", {}, "items", 3)
    expect(union.map((t: { taskId: string }) => t.taskId)).toEqual(["task_1", "task_2", "task_3"])
    await client.close()
  })

  it("the no-ledger guard reply keeps its structured {error} shape", async () => {
    const { client } = await setup([], { noLedger: true })
    const res = await client.callTool({ name: "task_list", arguments: {} })
    expect(isError(res)).toBe(false)
    expect(parseToolJson(res).error).toBe("task ledger not available")
    await client.close()
  })

  it("full records carry the verbose fields the compact projection drops", async () => {
    const { client } = await setup([fullTask])
    const full = parseToolJson(
      await client.callTool({ name: "task_list", arguments: { full: true } }),
    )
    expect(full.tasks[0].description).toBe("long description")
    expect(full.tasks[0].verify).toEqual({ command: "pnpm", args: ["test"] })
    expect(full.tasks[0].meta).toEqual({ prUrl: "https://example.test/pr/1" })
    await client.close()
  })
})

// ── app_list / app_list_applied ──────────────────────────────────────

describe("app_list / app_list_applied (paginated transformer)", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tt-apptools-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function installApps(count: number) {
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      const appId = `@test/tt-app-${i}`
      ids.push(appId)
      const app = defineApp({
        id: appId,
        name: appId,
        agents: [],
        ui: { html: "<html><body>tt</body></html>", title: appId, tools: ["known_tool"] },
      })
      await app.emit(join(dir, `app-${i}`))
    }
    const appRegistry = createAppRegistry()
    const client = await mcpClient(server =>
      registerAppTools(server, {
        registry: createSessionsRegistry({ persist: false }) as never,
        listRegisteredToolIds: async () => ["known_tool"],
        appRegistry,
      }),
    )
    for (let i = 0; i < count; i++) {
      const res = await client.callTool({
        name: "app_install",
        arguments: { dir: join(dir, `app-${i}`) },
      })
      if (isError(res)) throw new Error("fixture app_install failed")
    }
    return { client, ids, appRegistry }
  }

  it("app_list: default call is a bare COMPACT array; full:true restores ui/dev detail; page-walk unchanged", async () => {
    const { client, ids } = await installApps(3)

    const def = parseToolJson(await client.callTool({ name: "app_list", arguments: {} }))
    expect(Array.isArray(def)).toBe(true)
    expect(def.map((a: { appId: string }) => a.appId)).toEqual(ids)
    expect(typeof def[0].dataDir).toBe("string")
    expect(def[0].agents).toEqual([])
    expect(def[0].runs).toEqual([])
    expect(def[0].ui).toBeUndefined()
    expect(def[0].unvalidatedAgentTools).toBeUndefined()

    const full = parseToolJson(
      await client.callTool({ name: "app_list", arguments: { full: true } }),
    )
    expect(Array.isArray(full)).toBe(true)
    expect(full[0].ui).toMatchObject({ title: ids[0] })
    expect(full[0].unvalidatedAgentTools).toEqual([])

    const union = await pageWalk(client, "app_list", {}, "items", 3)
    expect(union.map((a: { appId: string }) => a.appId)).toEqual(ids)
    await client.close()
  })

  it("app_list_applied: default call is a bare COMPACT array; full:true keeps unvalidatedAgentTools; page-walk unchanged", async () => {
    const { client } = await installApps(1)
    for (const scopeId of ["s-1", "s-2", "s-3"]) {
      const res = await client.callTool({
        name: "app_apply",
        arguments: { appId: "@test/tt-app-0", scopeId },
      })
      if (isError(res)) throw new Error("fixture app_apply failed")
    }

    const def = parseToolJson(await client.callTool({ name: "app_list_applied", arguments: {} }))
    expect(Array.isArray(def)).toBe(true)
    expect(def.map((m: { scopeId: string }) => m.scopeId)).toEqual(["s-1", "s-2", "s-3"])
    expect(def[0]).toMatchObject({ appId: "@test/tt-app-0", agents: [], workflows: [] })
    expect(def[0].unvalidatedAgentTools).toBeUndefined()

    const full = parseToolJson(
      await client.callTool({ name: "app_list_applied", arguments: { full: true } }),
    )
    expect(full[0].unvalidatedAgentTools).toEqual([])

    const union = await pageWalk(client, "app_list_applied", {}, "items", 3)
    expect(union.map((m: { scopeId: string }) => m.scopeId)).toEqual(["s-1", "s-2", "s-3"])
    await client.close()
  })
})

// ── app_data_list ────────────────────────────────────────────────────

describe("app_data_list (paginated transformer)", () => {
  const APP_ID = "@test/tt-data-app"
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tt-appdata-"))
    await writeFile(join(dir, "b.json"), "{}", "utf8")
    await writeFile(join(dir, "a.txt"), "xxxx", "utf8")
    await mkdir(join(dir, "sub"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function setup() {
    const appRegistry = createAppRegistry()
    appRegistry.upsertApp({
      appId: APP_ID,
      dir,
      agents: [],
      workflows: [],
      unvalidatedAgentTools: [],
    })
    return mcpClient(server => registerAppDataTools(server, { appRegistry }))
  }

  it("default call keeps the {appId, dir, entries} envelope; entries are already compact and unchanged", async () => {
    const client = await setup()
    const def = parseToolJson(await client.callTool({ name: "app_data_list", arguments: { appId: APP_ID } }))
    expect(def.appId).toBe(APP_ID)
    expect(def.dir).toBe(".")
    expect(def.entries).toEqual([
      { name: "a.txt", type: "file", size: 4 },
      { name: "b.json", type: "file", size: 2 },
      { name: "sub", type: "directory", size: 0 },
    ])

    const full = parseToolJson(
      await client.callTool({ name: "app_data_list", arguments: { appId: APP_ID, full: true } }),
    )
    expect(full.entries).toEqual(def.entries)

    const union = await pageWalk(
      client,
      "app_data_list",
      { appId: APP_ID },
      "items",
      3,
    )
    expect(union.map((e: { name: string }) => e.name)).toEqual(["a.txt", "b.json", "sub"])
    await client.close()
  })

  it("fields filters per item on the paginated branch", async () => {
    const client = await setup()
    const page = parseToolJson(
      await client.callTool({
        name: "app_data_list",
        arguments: { appId: APP_ID, limit: 2, fields: ["name", "type"] },
      }),
    )
    expect(page.total).toBe(3)
    expect(page.items).toEqual([
      { name: "a.txt", type: "file" },
      { name: "b.json", type: "file" },
    ])
    await client.close()
  })
})

// ── app_external_list ────────────────────────────────────────────────

describe("app_external_list (paginated transformer)", () => {
  const APP_ID = "@test/tt-external-app"
  let sandboxDir: string
  let externalDir: string
  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "tt-ext-sandbox-"))
    externalDir = await mkdtemp(join(tmpdir(), "tt-ext-root-"))
    await writeFile(join(externalDir, "a.json"), "{}", "utf8")
    await writeFile(join(externalDir, "top.txt"), "x", "utf8")
    await mkdir(join(externalDir, "sub"))
  })
  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true })
    await rm(externalDir, { recursive: true, force: true })
  })

  async function setup() {
    const appRegistry = createAppRegistry()
    appRegistry.upsertApp({
      appId: APP_ID,
      dir: sandboxDir,
      agents: [],
      workflows: [],
      unvalidatedAgentTools: [],
      externalReadRoots: [externalDir],
    })
    return mcpClient(server => registerAppExternalTools(server, { appRegistry }))
  }

  it("default call keeps the {appId, root, path, entries} envelope; fields filters; page-walk unchanged", async () => {
    const client = await setup()
    const def = parseToolJson(
      await client.callTool({ name: "app_external_list", arguments: { appId: APP_ID, root: externalDir } }),
    )
    expect(def.appId).toBe(APP_ID)
    expect(def.root).toBe(externalDir)
    expect(def.path).toBe("")
    expect(def.entries).toEqual([
      { name: "a.json", isDirectory: false, size: 2 },
      { name: "sub", isDirectory: true },
      { name: "top.txt", isDirectory: false, size: 1 },
    ])

    const page = parseToolJson(
      await client.callTool({
        name: "app_external_list",
        arguments: { appId: APP_ID, root: externalDir, limit: 2, fields: ["name"] },
      }),
    )
    expect(page.total).toBe(3)
    expect(page.items).toEqual([{ name: "a.json" }, { name: "sub" }])

    const union = await pageWalk(
      client,
      "app_external_list",
      { appId: APP_ID, root: externalDir },
      "items",
      3,
    )
    expect(union.map((e: { name: string }) => e.name)).toEqual(["a.json", "sub", "top.txt"])
    await client.close()
  })

  it("the not-granted error keeps its legacy JSON {error} shape", async () => {
    const client = await setup()
    const res = await client.callTool({
      name: "app_external_list",
      arguments: { appId: APP_ID, root: join(externalDir, "sub") },
    })
    expect(isError(res)).toBe(true)
    expect(parseToolJson(res).error).toContain("not granted")
    await client.close()
  })
})
