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
/** A creation timestamp well past the 15-minute grace window. */
const oldEnough = (): string => new Date(Date.now() - 60 * 60 * 1000).toISOString()
/** A creation timestamp inside the grace window. */
const freshEnough = (): string => new Date(Date.now() - 60 * 1000).toISOString()

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
            // An orphan: unknown to the ledger, no live session, past the
            // grace window, no attached session.
            { id: "cmp-orphan", state: "stopped", sessions: 0, memoryMiB: 4096, createdAt: oldEnough() },
            // A box the provider still counts a session on: IN USE, never a
            // candidate (not even while it runs).
            { id: "cmp-attached", state: "running", sessions: 1, createdAt: oldEnough() },
            // A box that is still inside the 15-minute grace window: too
            // fresh to be proven stale.
            { id: "cmp-fresh", state: "stopped", sessions: 0, createdAt: freshEnough() },
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
    const candidates = out.candidates as Array<{ boxId: string; state: string; reason: string }>
    // Only the past-the-grace-window, unattached, unknown box is a
    // candidate: the attached one and the fresh one are NOT.
    expect(candidates.map(c => c.boxId)).toEqual(["cmp-orphan"])
    expect(candidates[0]?.reason).toContain("no live session")
    expect(removed).toEqual([])
  })

  it("deletes the orphan boxes with apply", async () => {
    removed = []
    const out = await callTool({ providers: ["computer"], apply: true })
    expect(out.applied).toBe(true)
    // ONLY the proven orphan is force-deleted: a box the provider still
    // counts a session on (cmp-attached) and a box inside the grace window
    // (cmp-fresh) are NEVER destroyed, running or not.
    expect(removed).toEqual([{ id: "cmp-orphan", force: true }])
    expect(out.deleted).toEqual(["cmp-orphan"])
  })
})
