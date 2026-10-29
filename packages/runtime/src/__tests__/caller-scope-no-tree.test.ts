/**
 * T15 safety gate: with no WORKSPACE.md tree declared anywhere above a
 * session's ground, every read behaves exactly as it did before the node-scope
 * enforcement. Each adapter is driven twice, once as a host call and once as a
 * session grounded in the tree-less directory, and the answers must be
 * identical. These tests pass on the old code too, by design: they pin the
 * behaviour that must not change. Temp dirs only.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { createMcpServer } from "@agentproto/mcp-server"
import { FilesMemoryStore, type MemoryDocument } from "@agentproto/memory"

import { registerAppDataTools } from "../app-data.js"
import { createAppRegistry } from "../app-registry.js"
import { registerBrainTools } from "../brain-tools.js"
import { CallerScopes, HOST_CALLER, type CallerScope } from "../caller-scope.js"
import { registerFsTools } from "../fs-tools.js"
import { createImportedCallGuard } from "../imported-call-gate.js"
import { registerMemoryTools } from "../memory-tools.js"
import { McpProxyRegistry } from "../mcp-proxy.js"
import { FakeSessions } from "./caller-scope-fixture.js"

const SESSION_ID = "sess_free_tree"
let base: string
let ground: string
let sessions: FakeSessions
let scopes: CallerScopes

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "caller-scope-notree-")))
  ground = join(base, "project", "src")
  mkdirSync(join(ground, "apps", "todo", "data"), { recursive: true })
  writeFileSync(join(base, "project", "readme.txt"), "README")
  writeFileSync(join(ground, "code.txt"), "CODE")
  writeFileSync(join(ground, "apps", "todo", "data", "todo.json"), JSON.stringify({ todo: "TODO-APP" }))
  sessions = new FakeSessions()
  sessions.byId.set(SESSION_ID, { cwd: ground, operator: "operator:jeremy" })
  scopes = new CallerScopes()
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const session = (): CallerScope => scopes.resolve(SESSION_ID, sessions)

async function connect(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "t", version: "0.0.1" })
  await client.connect(clientTransport)
  return {
    async call(name: string, args: Record<string, unknown>) {
      const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean }
      return { isError: r.isError === true, text: r.content[0]!.text }
    },
    close: () => client.close(),
  }
}

describe("a session with no declared tree is classified as unwalled", () => {
  it("has no node and a host call has no scope", () => {
    const s = session()
    expect(s.kind).toBe("session")
    expect(s.kind === "session" && s.node).toBeUndefined()
    expect(HOST_CALLER.kind).toBe("host")
  })

  it("a ground in a sub-sub folder and a ground that does not exist yet are still unwalled", () => {
    for (const cwd of [join(ground, "apps", "todo"), join(base, "not", "created", "yet")]) {
      sessions.byId.set("sess_x", { cwd })
      const s = scopes.resolve("sess_x", sessions)
      expect(s.kind, cwd).toBe("session")
      expect(s.kind === "session" && s.node, cwd).toBeUndefined()
    }
  })
})

describe("file tools", () => {
  it("answer a tree-less session exactly as they answer the host", async () => {
    const answers: string[][] = []
    for (const callerScope of [HOST_CALLER, session()]) {
      const server = new McpServer({ name: "fs", version: "0" })
      registerFsTools(server, { workspace: base, callerScope, scopes } as never)
      const h = await connect(server)
      const out: string[] = []
      for (const [tool, args] of [
        ["file_read", { path: "project/readme.txt" }],
        ["file_info", { path: "project/src/code.txt" }],
        ["directory_list", { path: "project" }],
        ["directory_list", {}],
        ["file_write", { path: "project/src/out.txt", content: "x" }],
        ["directory_create", { path: "project/made" }],
        ["file_delete", { path: "project/src/out.txt" }],
        ["file_read", { path: "../outside.txt" }],
      ] as const) {
        out.push(JSON.stringify(await h.call(tool, args)).replace(/\\"(modified|created)\\":\\"[^"\\]*\\",?/g, ""))
      }
      answers.push(out)
      await h.close()
      rmSync(join(base, "project", "made"), { recursive: true, force: true })
    }
    expect(answers[1]).toEqual(answers[0])
    expect(answers[0]![0]).toContain("README")
  })
})

describe("app-data tools", () => {
  it("answer a tree-less session exactly as they answer the host", async () => {
    const answers: unknown[][] = []
    for (const callerScope of [HOST_CALLER, session()]) {
      const appRegistry = createAppRegistry()
      appRegistry.upsertApp({ appId: "@me/todo", dir: join(ground, "apps", "todo"), agents: [], workflows: [], unvalidatedAgentTools: [] })
      const server = new McpServer({ name: "app-data", version: "0" })
      registerAppDataTools(server, { appRegistry, callerScope, scopes } as never)
      const h = await connect(server)
      answers.push([
        await h.call("app_data_read", { appId: "@me/todo", path: "todo.json" }),
        await h.call("app_data_list", { appId: "@me/todo" }),
        await h.call("app_state_list", { appId: "@me/todo" }),
        await h.call("app_data_read", { appId: "@me/missing", path: "x.json" }),
      ])
      await h.close()
    }
    expect(answers[1]).toEqual(answers[0])
    expect(JSON.stringify(answers[0])).toContain("TODO-APP")
  })
})

describe("workspace_brain_query", () => {
  it("forwards the query untouched, topK included, and returns every hit", async () => {
    const seen: unknown[][] = []
    const results: string[] = []
    for (const callerScope of [HOST_CALLER, session()]) {
      const queries: unknown[] = []
      const hits = ["a", "b", "c"].map((t, i) => ({ sourceId: t, chunkId: t, text: t, score: 3 - i, metadata: { sessionId: i === 0 ? "sess_gone" : SESSION_ID } }))
      const brains = {
        getBrain: () => ({
          getProvider: () => ({
            query: async (q: unknown) => {
              queries.push(q)
              return { hits, tookMs: 1, engine: "fake", modeUsed: "keyword" }
            },
          }),
        }),
        resolveWorkspace: async () => undefined,
        resolveWorkspaceSlug: () => "default",
      }
      const server = new McpServer({ name: "brain", version: "0" })
      registerBrainTools(server, { brains, registry: sessions, callerScope, scopes } as never)
      const h = await connect(server)
      results.push((await h.call("workspace_brain_query", { query: "q", topK: 7 })).text.replace(/"tookMs":\d+/, ""))
      await h.close()
      seen.push(queries)
    }
    expect(seen[1]).toEqual(seen[0])
    expect(results[1]).toEqual(results[0])
    expect(results[0]).toContain('"text":"a"')
  })
})

describe("memory tools", () => {
  const doc = (id: string): MemoryDocument => ({
    schema: "memory/v1",
    slug: id,
    kind: "feedback",
    type: "feedback",
    title: `Title ${id}`,
    updated_at: "2026-10-01T00:00:00.000Z",
    id,
    polarity: "do",
    tags: ["global"],
    provenance: { source: "converse", at: "2026-10-01T00:00:00.000Z" },
    body: `Body of ${id} mentions zebra.\n`,
  })

  it("answer a tree-less session exactly as they answer the host, for every item a tree-less store holds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "caller-scope-notree-mem-"))
    try {
      const store = new FilesMemoryStore({ root: dir, now: () => new Date("2026-10-28T10:00:00.000Z") })
      for (const id of ["one", "two", "three"]) await store.write(doc(id), { mode: "commit" })
      await store.write(doc("pending"), { mode: "propose" })
      const answers: string[][] = []
      for (const callerScope of [HOST_CALLER, session()]) {
        const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
        registerMemoryTools(server, {
          store: () => store,
          caller: { kind: "session", id: "sess_sup", role: "supervisor" },
          callerScope,
        } as never)
        const h = await connect(server)
        answers.push([
          JSON.stringify(await h.call("memory_list", {})),
          JSON.stringify(await h.call("memory_list", { limit: 1 })),
          JSON.stringify(await h.call("memory_list", { status: "proposed" })),
          JSON.stringify(await h.call("memory_search", { query: "zebra" })),
          JSON.stringify(await h.call("memory_read", { id: "two" })),
        ])
        await h.close()
      }
      expect(answers[1]).toEqual(answers[0])
      expect(answers[0]![0]).toContain("Title one")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("imported-call gate", () => {
  it("lets the call through with its arguments unchanged and the upstream result returned", async () => {
    for (const callerSessionId of [undefined, SESSION_ID]) {
      const proxy = new McpProxyRegistry()
      proxy.setCallGuard(
        createImportedCallGuard({ registry: { get: (id: string) => sessions.get(id), requestToolPermission: vi.fn() } as never, workspace: base, scopes } as never),
      )
      const callTool = vi.fn(async (_req: unknown) => ({ content: [{ type: "text", text: "UPSTREAM" }] }))
      vi.spyOn(proxy as never, "connectIfNeeded" as never).mockImplementation((async () => ({ alias: "app", client: { callTool }, tools: [] })) as never)
      const out = await proxy.callTool("app", "do", { a: 1 }, callerSessionId === undefined ? undefined : { callerSessionId })
      expect(out.ok).toBe(true)
      expect(callTool).toHaveBeenCalledTimes(1)
      expect(callTool.mock.calls[0]![0]).toMatchObject({ name: "do", arguments: { a: 1 } })
    }
  })
})
