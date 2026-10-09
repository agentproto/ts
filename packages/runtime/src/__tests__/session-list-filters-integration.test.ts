/**
 * End-to-end coverage of the `session_list` narrowing filters over both the
 * MCP tool and `GET /sessions`, driven through a real registry. The pure
 * predicate logic lives in session-list-filters.test.ts.
 */

import { afterEach, describe, expect, it } from "vitest"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry, type PtyFactory } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent, SessionsRegistry } from "../sessions.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

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
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      await new Promise(() => {})
    },
    async cancel() {},
    async close() {},
  }
}

interface Seeded {
  main: string
  review: string
  wf: string
  child: string
  oneShot: string
  liveTerm: string
}

function seed(registry: SessionsRegistry): Seeded {
  const agent = (extra: Record<string, unknown>): string =>
    registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/work/app",
      agentSession: fakeAgentSession("agent"),
      adapterSlug: "fake",
      ...extra,
    } as never).id
  const main = agent({ label: "pygmalion-brain", title: "Fix the checkout bug" })
  const review = agent({ label: "review:studio:claims", origin: "review", parentSessionId: main })
  const wf = agent({ label: "wf:revise/reader-probe", origin: "workflow" })
  const child = agent({ label: "helper", parentSessionId: main })
  const oneShot = registry.spawnPty({
    workspaceSlug: "default",
    cwd: "/work/scanner",
    argv: ["bash", "-lc", "echo hi"],
    cols: 80,
    rows: 24,
    name: "scanner-tests8",
  }).id
  registry.kill(oneShot)
  const liveTerm = registry.spawnPty({
    workspaceSlug: "default",
    cwd: "/work/app",
    argv: ["bash"],
    cols: 80,
    rows: 24,
    name: "dev-server",
  }).id
  return { main, review, wf, child, oneShot, liveTerm }
}

function textOf(result: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (result as any).content[0]?.text ?? "{}"
}

describe("session_list filters (MCP)", () => {
  let closeFn: (() => Promise<void>) | undefined
  let registry: SessionsRegistry | undefined

  afterEach(async () => {
    await closeFn?.()
    registry?.shutdown()
  })

  async function harness(): Promise<{ call: (args: Record<string, unknown>) => Promise<any>; ids: Seeded }> {
    registry = createSessionsRegistry({ persist: false, spawnPty: fakePtyFactory })
    const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
    registerSessionTools(server, { registry, workspace: process.cwd() })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const client = new Client({ name: "test-client", version: "0" })
    await client.connect(ct)
    closeFn = () => client.close()
    const ids = seed(registry)
    return {
      ids,
      call: async args => {
        const res = await client.callTool({ name: "session_list", arguments: { kind: "all", ...args } })
        const text = textOf(res)
        let body: any
        try {
          body = JSON.parse(text)
        } catch {
          body = text
        }
        return { res, body }
      },
    }
  }

  it("unfiltered output is unchanged apart from the additive total", async () => {
    const { call } = await harness()
    const { body } = await call({})
    expect(body.sessions).toHaveLength(6)
    expect(body.total).toBe(6)
    expect(body.nextCursor).toBeUndefined()
  })

  it("q narrows by title/label/name/cwd and total reflects the filtered set", async () => {
    const { call, ids } = await harness()
    expect((await call({ q: "CHECKOUT" })).body.sessions.map((s: { id: string }) => s.id)).toEqual([ids.main])
    expect((await call({ q: "scanner" })).body.sessions.map((s: { id: string }) => s.id)).toEqual([ids.oneShot])
    const { body } = await call({ q: "scanner", limit: 5 })
    expect(body.total).toBe(1)
    expect(body.items).toHaveLength(1)
  })

  it("excludeNoise drops review/wf lanes and ended one-shot terminals", async () => {
    const { call, ids } = await harness()
    const got = (await call({ excludeNoise: true })).body.sessions.map((s: { id: string }) => s.id).sort()
    expect(got).toEqual([ids.main, ids.child, ids.liveTerm].sort())
  })

  it("excludeLabelPrefix / excludeKinds / rootOnly / parentSessionId", async () => {
    const { call, ids } = await harness()
    const idsOf = async (args: Record<string, unknown>): Promise<string[]> =>
      (await call(args)).body.sessions.map((s: { id: string }) => s.id).sort()
    expect(await idsOf({ excludeLabelPrefix: ["review:", "wf:"] })).not.toContain(ids.review)
    expect(await idsOf({ excludeLabelPrefix: "review:" })).toContain(ids.wf)
    expect(await idsOf({ excludeKinds: "terminal" })).toEqual([ids.main, ids.review, ids.wf, ids.child].sort())
    expect(await idsOf({ rootOnly: true })).not.toContain(ids.child)
    expect(await idsOf({ parentSessionId: ids.main })).toEqual([ids.review, ids.child].sort())
  })

  it("relative updatedSince keeps fresh sessions; a far-future ISO bound matches none", async () => {
    const { call } = await harness()
    expect((await call({ updatedSince: "1h" })).body.sessions).toHaveLength(6)
    expect((await call({ updatedSince: "2999-01-01T00:00:00Z" })).body.sessions).toHaveLength(0)
  })

  it("rows come back newest-activity-first and pages stay in that order", async () => {
    const { call } = await harness()
    const { body } = await call({})
    const acts = body.sessions.map((s: { lastActivityAt?: string; startedAt: string }) =>
      Date.parse(s.lastActivityAt ?? s.startedAt),
    )
    expect([...acts].sort((a, b) => b - a)).toEqual(acts)
    const p1 = (await call({ limit: 2 })).body
    const p2 = (await call({ limit: 2, cursor: p1.nextCursor })).body
    expect([...p1.items, ...p2.items].map((s: { id: string }) => s.id)).toEqual(
      body.sessions.slice(0, 4).map((s: { id: string }) => s.id),
    )
  })

  it("fields is honoured without limit", async () => {
    const { call } = await harness()
    const { body } = await call({ fields: ["id", "label"] })
    for (const s of body.sessions) expect(Object.keys(s).sort()).toEqual(Object.keys(s).filter(k => ["id", "label"].includes(k)).sort())
    expect(body.sessions[0]).not.toHaveProperty("cwd")
  })

  it("a malformed time bound is an error result naming the field, not an empty list", async () => {
    const { call } = await harness()
    const { res, body } = await call({ updatedSince: "last week" })
    expect((res as { isError?: boolean }).isError).toBe(true)
    expect(String(typeof body === "string" ? body : JSON.stringify(body))).toContain("updatedSince")
  })
})

describe("GET /sessions filters (HTTP)", () => {
  let stop: (() => Promise<void>) | undefined
  afterEach(async () => {
    await stop?.()
    stop = undefined
  })

  const resolveAgentAdapter: AgentAdapterResolver = async () => ({
    async startSession() {
      throw new Error("not used")
    },
    commandPreview: "mock-adapter",
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

  async function withServer(run: (get: (qs: string) => Promise<Response>, ids: Seeded) => Promise<void>) {
    const registry = createSessionsRegistry({ persist: false, spawnPty: fakePtyFactory })
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
      mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
      conversations,
      events: createRuntimeEvents(),
      heartbeat,
      sessions: registry,
      resolveAgentAdapter,
      meta: { workspace: process.cwd(), registered: [] },
    })
    stop = () => http.stop()
    try {
      await run(qs => fetch(`http://127.0.0.1:${port}/sessions${qs}`), seed(registry))
    } finally {
      await http.stop()
      stop = undefined
      registry.shutdown()
    }
  }

  const idsOf = async (res: Response): Promise<string[]> =>
    ((await res.json()) as { sessions: { id: string }[] }).sessions.map(s => s.id).sort()

  it("with no filter params the body has no total (legacy shape)", async () => {
    await withServer(async get => {
      const body = (await (await get("")).json()) as Record<string, unknown>
      expect(body).not.toHaveProperty("total")
      expect((body.sessions as unknown[]).length).toBe(6)
    })
  })

  it("applies filters, reports total and honours limit after filtering", async () => {
    await withServer(async (get, ids) => {
      expect(await idsOf(await get("?excludeNoise=true"))).toEqual([ids.main, ids.child, ids.liveTerm].sort())
      expect(await idsOf(await get("?q=checkout"))).toEqual([ids.main])
      expect(await idsOf(await get(`?parentSessionId=${ids.main}`))).toEqual([ids.review, ids.child].sort())
      expect(await idsOf(await get("?excludeLabelPrefix=review:&excludeLabelPrefix=wf:&rootOnly=true"))).toEqual(
        [ids.main, ids.oneShot, ids.liveTerm].sort(),
      )
      const limited = (await (await get("?excludeNoise=true&limit=2")).json()) as { sessions: unknown[]; total: number }
      expect(limited.sessions).toHaveLength(2)
      expect(limited.total).toBe(3)
    })
  })

  it("rejects bad filter values with 400", async () => {
    await withServer(async get => {
      const bad = await get("?updatedSince=nonsense")
      expect(bad.status).toBe(400)
      expect(((await bad.json()) as { error: string }).error).toBe("invalid_filter")
      expect((await get("?q=x&limit=abc")).status).toBe(400)
    })
  })
})
