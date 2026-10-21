/**
 * The `sandbox_gc` MCP tool: the daemon-side twin of `agentproto sandbox gc`.
 * It must SEE the orphan boxes of a provider's control plane (the computer
 * controller), list them by default, and delete them (forced) only when
 * asked to apply.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

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

function noopStub(): never {
  return new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : async () => undefined) }) as never
}
const noopFn = (): never => (async () => undefined) as never
const listFn = (): never => (async () => []) as never

/** A creation time well outside the 15-minute grace window. */
const old = (): string => new Date(Date.now() - 60 * 60_000).toISOString()
/** A creation time inside the grace window - an in-flight boot. */
const fresh = (): string => new Date(Date.now() - 60_000).toISOString()

let home = ""
let gateway: { url: string; stop: () => Promise<void> } | undefined
/** Every `remove()` the fake provider received. */
let removed: Array<{ id: string; force: boolean | undefined }> = []

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "sandbox-gc-mcp-"))
  vi.stubEnv("HOME", home)
  vi.stubEnv("AGENTPROTO_HOME", join(home, ".agentproto"))
  const { createGateway } = await import("../index.js")
  const workspace = await mkdtemp(join(home, "ws-"))
  removed = []
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
      if (slug !== "computer") return null
      return {
        provider: {
          listBoxes: async () => [
            // An orphan: old enough, and the provider counts no session.
            { id: "cmp-orphan", state: "stopped", sessions: 0, memoryMiB: 4096, createdAt: old() },
            // Another daemon's box on the shared tenant: the provider still
            // counts its session slot, so it is NOT a candidate by default.
            { id: "cmp-other-daemon", state: "running", sessions: 1, createdAt: old() },
            // An in-flight boot: too young to be an orphan.
            { id: "cmp-fresh", state: "running", sessions: 0, createdAt: fresh() },
            // The provider does not say how old this one is.
            { id: "cmp-unknown-age", state: "running", sessions: 0 },
          ],
          remove: async (id: string, opts?: { force?: boolean }) => {
            removed.push({ id, force: opts?.force })
          },
        },
        slug: "computer",
        name: "Computer",
        version: "installed",
        description: "fake",
        requiresSetup: false,
        capabilities: {
          networkEgress: true,
          mounts: false,
          lifecyclePause: false,
          readOnly: false,
        },
        check: async () => true,
      }
    }) as never,
  })
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  if (gateway) await gateway.stop()
  await rm(home, { recursive: true, force: true })
})

async function callTool(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const client = new Client({ name: "sandbox-gc-test", version: "0" }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway?.url}/mcp`)))
  try {
    const res = await client.callTool({ name: "sandbox_gc", arguments: args })
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}"
    return JSON.parse(text) as Record<string, unknown>
  } finally {
    await client.close()
  }
}

describe("sandbox_gc MCP tool", () => {
  it("lists the provider's orphan boxes and deletes nothing by default", async () => {
    const out = await callTool({ providers: ["computer"] })
    expect(out.applied).toBe(false)
    expect(out.scanned).toBe(true)
    const candidates = out.candidates as Array<{ boxId: string; state: string; reason: string }>
    // Only the box that is old enough AND reported unattached.
    expect(candidates.map(c => c.boxId)).toEqual(["cmp-orphan"])
    expect(candidates[0]?.reason).toContain("no live session")
    expect(removed).toEqual([])
  })

  it("never deletes a box the provider still counts a session for", async () => {
    removed = []
    const out = await callTool({ providers: ["computer"], apply: true })
    expect(out.applied).toBe(true)
    expect(removed).toEqual([{ id: "cmp-orphan", force: true }])
    expect(out.deleted).toEqual(["cmp-orphan"])
  })

  it("includeAttached opts in to the boxes the provider still counts", async () => {
    removed = []
    const out = await callTool({ providers: ["computer"], apply: true, includeAttached: true })
    const candidates = out.candidates as Array<{ boxId: string }>
    expect(candidates.map(c => c.boxId)).toEqual(["cmp-orphan", "cmp-other-daemon"])
    expect(removed).toEqual([
      { id: "cmp-orphan", force: true },
      { id: "cmp-other-daemon", force: true },
    ])
  })

  it("minAgeMs shortens the grace window", async () => {
    removed = []
    const out = await callTool({ providers: ["computer"], apply: true, minAgeMs: 0 })
    const candidates = out.candidates as Array<{ boxId: string }>
    // The fresh box now qualifies; the unknown-age one never does.
    expect(candidates.map(c => c.boxId)).toEqual(["cmp-orphan", "cmp-fresh"])
    expect(removed.map(r => r.id)).toEqual(["cmp-orphan", "cmp-fresh"])
  })
})
