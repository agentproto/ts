/**
 * `sandbox_list` and the provider sweep defaults.
 *
 * The inventory reads every provider INDEPENDENTLY: a throwing provider is
 * reported per provider and never hides another provider's rows, duplicate
 * boxes are merged on provider + id, and totals exclude unknown costs while
 * flagging the result as partial. The same default provider set feeds
 * `sandbox_list` and `sandbox_gc` deliberately differ: listing every
 * concrete provider is read-only and safe, but a bare gc sweeps ONLY
 * `computer` because its controller scopes boxes to this daemon's tenant.
 * `e2b` shares an account across daemons, machines, CI and tools and writes
 * no daemon marker at boot, so naming it explicitly reports it as
 * `notScanned` and deletes nothing.
 *
 * Fail on main: `sandbox_list` is unregistered; the inventory does not exist;
 * a two-provider fake returns only one provider's rows; a throwing provider
 * yields no `errors`; duplicate ids are not merged; a bare `sandbox_gc`
 * sweeps every provider; an explicit e2b sweep deletes shared boxes.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { collectSandboxInventory } from "../sandbox-inventory.js"

const FROM = "2026-10-26T00:00:00.000Z"
const TO = "2026-10-27T00:00:00.000Z"
const OLD = new Date(Date.now() - 60 * 60 * 1000).toISOString()

function noopStub(): never {
  return new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : async () => undefined) }) as never
}
const noopFn = (): never => (async () => undefined) as never
const listFn = (): never => (async () => []) as never

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

function usageWindow(computer: string, costEur: number | null, activeSec = 10) {
  return {
    computer,
    tenantId: "tenant",
    provider: "computer" as const,
    from: FROM,
    to: TO,
    activeSec,
    vcpuSec: activeSec * 2,
    gibSec: activeSec / 2,
    costEur,
  }
}

describe("collectSandboxInventory", () => {
  it("merges two providers and tags every row with its provider", async () => {
    const out = await collectSandboxInventory({
      providers: [
        { slug: "computer", provider: { list: async () => [{ id: "cmp-1", provider: "computer" }] } as never },
        { slug: "e2b", provider: { list: async () => [{ id: "e2b-1", provider: "e2b" }] } as never },
      ],
    })
    expect(out.boxes.map(b => `${b.provider}:${b.id}`)).toEqual(["computer:cmp-1", "e2b:e2b-1"])
    expect(out.errors).toEqual([])
  })

  it("reports a throwing provider and still returns the other provider's rows", async () => {
    const out = await collectSandboxInventory({
      providers: [
        {
          slug: "computer",
          provider: {
            list: async () => {
              throw new Error("controller down")
            },
          } as never,
        },
        { slug: "e2b", provider: { list: async () => [{ id: "e2b-1", provider: "e2b" }] } as never },
      ],
    })
    expect(out.errors).toEqual([{ provider: "computer", error: "controller down" }])
    expect(out.boxes.map(b => b.id)).toEqual(["e2b-1"])
  })

  it("merges duplicate boxes on provider + id, keeping known fields", async () => {
    const out = await collectSandboxInventory({
      providers: [
        {
          slug: "computer",
          provider: {
            list: async () => [
              { id: "dup", provider: "computer", state: "running" },
              { id: "dup", provider: "computer", cpus: 2, memoryMiB: 2048 },
            ],
          } as never,
        },
      ],
    })
    expect(out.boxes).toHaveLength(1)
    expect(out.boxes[0]).toMatchObject({ id: "dup", state: "running", cpus: 2, memoryMiB: 2048 })
  })

  it("keeps the same id from different providers distinct", async () => {
    const out = await collectSandboxInventory({
      providers: [
        { slug: "computer", provider: { list: async () => [{ id: "same", provider: "computer" }] } as never },
        { slug: "e2b", provider: { list: async () => [{ id: "same", provider: "e2b" }] } as never },
      ],
    })
    expect(out.boxes.map(b => b.provider)).toEqual(["computer", "e2b"])
  })

  it("sums usage excluding null costs and flags the total partial", async () => {
    const out = await collectSandboxInventory({
      includeUsage: true,
      from: FROM,
      to: TO,
      providers: [
        {
          slug: "computer",
          provider: {
            list: async () => [],
            usage: async () => [usageWindow("a", 1, 10), usageWindow("b", null, 5)],
          } as never,
        },
      ],
    })
    expect(out.totals).toEqual({
      activeSec: 15,
      vcpuSec: 30,
      gibSec: 7.5,
      costEur: 1,
      costPartial: true,
    })
  })

  it("reports a provider without list as not scanned instead of failing", async () => {
    const out = await collectSandboxInventory({
      providers: [{ slug: "e2b", provider: {} as never }],
    })
    expect(out.boxes).toEqual([])
    expect(out.errors).toEqual([])
    expect(out.notScanned).toEqual([{ provider: "e2b", reason: "the provider cannot enumerate its boxes (no list)" }])
  })
})

let home = ""
let gateway: { url: string; stop: () => Promise<void> } | undefined
/** Every `remove()` the fake e2b provider received. */
let e2bRemoved: string[] = []

function fakeHandle(slug: string, provider: Record<string, unknown>): Record<string, unknown> {
  return {
    provider,
    slug,
    name: slug,
    version: "fake",
    description: "fake",
    requiresSetup: false,
    capabilities: { networkEgress: true, mounts: false, lifecyclePause: true, readOnly: false },
    check: async () => true,
  }
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "sandbox-list-"))
  vi.stubEnv("HOME", home)
  vi.stubEnv("AGENTPROTO_HOME", join(home, ".agentproto"))
  const { createGateway } = await import("../index.js")
  const workspace = await mkdtemp(join(home, "ws-"))
  gateway = await createGateway({
    workspace,
    specs: [],
    port: await freePort(),
    boot: false,
    persist: false,
    persistPath: join(workspace, "sessions.json"),
    pairingRegistry: noopStub(),
    hostRegistry: noopStub(),
    joinTokens: noopStub(),
    resolveAgentAdapter: noopFn(),
    installAgentAdapter: noopFn(),
    listAgentAdapters: listFn(),
    listBrowserAdapters: listFn(),
    resolveBrowserAdapter: noopFn(),
    listCatalogModels: listFn(),
    listHarnessCapabilities: listFn(),
    listWorktreeStatuses: listFn(),
    provisionWorktree: noopFn(),
    readBranchGcVerdict: noopFn(),
    recordBranchGcVerdict: noopFn(),
    resolveOpenPr: noopFn(),
    resolvePrState: noopFn(),
    runBranchGc: noopFn(),
    runWorktreeAutoReclaim: noopFn(),
    runWorktreeGc: noopFn(),
    listSandboxProviders: listFn(),
    resolveSandboxProvider: (async (slug: string) => {
      if (slug === "computer") {
        return fakeHandle(slug, {
          listBoxes: async () => [
            { id: "cmp-orphan", state: "stopped", sessions: 0, createdAt: OLD },
          ],
          list: async () => [{ id: "cmp-1", provider: "computer", state: "running" }],
          usage: async () => [usageWindow("cmp-1", 2)],
        })
      }
      if (slug === "e2b") {
        return fakeHandle(slug, {
          listBoxes: async () => [
            { id: "e2b-orphan", state: "paused", sessions: 0, createdAt: OLD },
          ],
          list: async () => [{ id: "e2b-1", provider: "e2b", state: "paused" }],
          usage: async () => [usageWindow("e2b-1", null)],
          remove: async (id: string) => {
            e2bRemoved.push(id)
          },
        })
      }
      return null
    }) as never,
  })
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  if (gateway) await gateway.stop()
  await rm(home, { recursive: true, force: true })
})

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "sandbox-list-test", version: "0" }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway?.url}/mcp`)))
  try {
    return await fn(client)
  } finally {
    await client.close()
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return withClient(async client => {
    const res = await client.callTool({ name, arguments: args })
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}"
    return JSON.parse(text) as Record<string, unknown>
  })
}

describe("sandbox_list MCP tool", () => {
  it("is registered", async () => {
    const names = await withClient(async client => (await client.listTools()).tools.map(t => t.name))
    expect(names).toContain("sandbox_list")
  })

  it("returns both providers' boxes and usage totals in one call", async () => {
    const out = await callTool("sandbox_list", { includeUsage: true, from: FROM, to: TO })
    expect((out.boxes as Array<{ provider: string; id: string }>).map(b => `${b.provider}:${b.id}`)).toEqual([
      "e2b:e2b-1",
      "computer:cmp-1",
    ])
    expect(out.usage).toHaveLength(2)
    expect(out.totals).toEqual({
      activeSec: 20,
      vcpuSec: 40,
      gibSec: 10,
      costEur: 2,
      costPartial: true,
    })
  })
})

describe("sandbox_gc default providers", () => {
  it("sweeps only computer when no providers are given", async () => {
    const out = await callTool("sandbox_gc", {})
    const candidates = out.candidates as Array<{ provider: string; boxId: string }>
    expect(candidates.map(c => `${c.provider}:${c.boxId}`)).toEqual(["computer:cmp-orphan"])
  })

  it("refuses an explicit e2b sweep: no daemon marker, notScanned, nothing deleted", async () => {
    e2bRemoved = []
    const out = await callTool("sandbox_gc", { providers: ["e2b"], apply: true })
    expect(out.candidates).toEqual([])
    expect(out.deleted).toEqual([])
    expect(out.notScanned).toEqual([
      {
        provider: "e2b",
        reason:
          "the e2b provider writes no daemon marker at boot, so its boxes " +
          "cannot be attributed to this daemon; its account is shared with other " +
          "daemons, machines, CI and tools - refusing to sweep it",
      },
    ])
    expect(e2bRemoved).toEqual([])
  })
})
