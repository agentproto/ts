/**
 * `turnRetry` DEFAULT for executor / sandbox spawns (graceful retry is on
 * out of the box). A spawn that gave no `turnRetry` (explicit, or via a
 * preset) gets the default policy in session-spawn.ts: rate-limit,
 * upstream-5xx, no-output-stall; 6 retries) while a supervisor spawn keeps
 * the old opt-in behaviour. An explicit opt-out (`turnRetry: null`, or an
 * empty `on`) still disables it. A FREE OpenCode current model also rotates
 * on 5xx by default, and its rotate list is free ids only.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import type { SandboxProvider } from "@agentproto/sandbox"

import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { inModelList } from "@agentproto/model-catalog/lists"
import { DEFAULT_ROTATION_LIST_ID, saveModelList, seedModelListSource, ZERO_COST_LIST_ID } from "../model-list-store.js"
import { createGateway, type GatewayHandle } from "../index.js"
import { createSessionsRegistry, type AgentSessionLike, type SessionsRegistry, type AgentStreamEvent } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"

const FREE_ROTATE_IDS = ["opencode/mimo-v2.6-flash-free", "opencode/deepseek-v4.1-flash-free", "opencode/glm-5.3-flash-free"]

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

function fakeAgent(): AgentSessionLike {
  return {
    sessionId: "fake_agent_1",
    async *send(): AsyncIterable<AgentStreamEvent> {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
}

const fakeAdapterResolver: AgentAdapterResolver = async slug =>
  slug === "fake-cli"
    ? { commandPreview: "fake-cli (test double)", startSession: async () => fakeAgent() }
    : null

function makeDeps(registry: SessionsRegistry): SpawnAgentSessionDeps {
  return {
    registry,
    resolveAgentAdapter: fakeAdapterResolver,
    loadDefaultsConfig: async () => undefined,
    loadRoleRegistry: async () => ({}),
  }
}

let home: string
const dirs: string[] = []
const cleanups: Array<() => Promise<void>> = []

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "agentproto-tr-default-home-"))
  dirs.push(home)
  process.env.HOME = home
})

afterEach(async () => {
  if (process.env.HOME === home) delete process.env.HOME
  for (const fn of cleanups.splice(0)) await fn().catch(() => {})
  await rm(home, { recursive: true, force: true })
})

function spawnLocal(deps: SpawnAgentSessionDeps, opts: Partial<Parameters<typeof spawnAgentSession>[1]> = {}) {
  return spawnAgentSession(deps, {
    adapter: "fake-cli",
    cwd: "/tmp",
    prompt: "do the thing",
    ...opts,
  })
}

async function descriptorOf(
  deps: SpawnAgentSessionDeps,
  opts: Partial<Parameters<typeof spawnAgentSession>[1]> = {},
) {
  const result = await spawnLocal(deps, opts)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error("spawn failed")
  return result.descriptor
}

function turnRetryOf(desc: Awaited<ReturnType<typeof descriptorOf>>) {
  return desc.turnRetry
}

describe("agent_start turnRetry default for executor agents", () => {
  it("a default-role (supervisor) spawn gets NO policy, an executor role gets the default one", async () => {
    const registry = createSessionsRegistry({ persist: false })
    cleanups.push(() => Promise.resolve(registry.shutdown()))
    const deps = makeDeps(registry)

    // Omitted role at depth 0 resolves to supervisor (no default policy).
    const supervisor = await descriptorOf(deps)
    expect(turnRetryOf(supervisor)).toBeUndefined()

    const executor = await descriptorOf(deps, { role: "executor" })
    expect(turnRetryOf(executor)).toMatchObject({
      on: ["rate-limit", "upstream-5xx", "no-output-stall"],
      maxRetries: 6,
    })
  })

  it("an explicit policy stays untouched; a null or empty `on` disables the default", async () => {
    const registry = createSessionsRegistry({ persist: false })
    cleanups.push(() => Promise.resolve(registry.shutdown()))
    const deps = makeDeps(registry)

    const explicit = await descriptorOf(deps, {
      role: "executor",
      turnRetry: { on: ["rate-limit"], maxRetries: 1 },
    })
    expect(turnRetryOf(explicit)).toMatchObject({ on: ["rate-limit"], maxRetries: 1 })
    expect(turnRetryOf(explicit)?.rotate).toBeUndefined()

    const nulled = await descriptorOf(deps, { role: "executor", turnRetry: null })
    expect(turnRetryOf(nulled)?.on).toEqual([])

    const emptied = await descriptorOf(deps, { role: "executor", turnRetry: { on: [] } })
    expect(turnRetryOf(emptied)?.on).toEqual([])
  })

  it("a free model's default rotates on every class, to free ids minus the current one", async () => {
    const registry = createSessionsRegistry({ persist: false })
    cleanups.push(() => Promise.resolve(registry.shutdown()))
    const deps = makeDeps(registry)

    const free = await descriptorOf(deps, { role: "executor", model: "opencode/glm-5.3-flash-free" })
    const policy = turnRetryOf(free)
    expect(policy?.rotateOn).toEqual(["rate-limit", "upstream-5xx", "no-output-stall"])
    expect(policy?.rotate?.map(t => t.model)).toEqual(
      FREE_ROTATE_IDS.filter(m => m !== "opencode/glm-5.3-flash-free"),
    )
    for (const target of policy?.rotate ?? []) {
      expect(inModelList(target.model, ZERO_COST_LIST_ID, seedModelListSource())).toBe(true)
    }

    // A paid model never rotates by default.
    const paid = await descriptorOf(deps, { role: "executor", model: "claude-sonnet-4-5" })
    const paidPolicy = turnRetryOf(paid)
    expect(paidPolicy?.on).toMatchObject(["rate-limit", "upstream-5xx", "no-output-stall"])
    expect(paidPolicy?.rotate).toBeUndefined()
  })
  it("a preset carry-over turnRetry loses to an explicit null opt-out", async () => {
    const registry = createSessionsRegistry({ persist: false })
    cleanups.push(() => Promise.resolve(registry.shutdown()))
    const deps = makeDeps(registry)

    // The preloaded preset pins a turnRetry; the spawn itself opts out with
    // an explicit null, which must win.
    const optedOut = await descriptorOf(deps, {
      role: "executor",
      preset: { id: "retry-fast", label: "Retry fast", turnRetry: { on: ["rate-limit"], maxRetries: 3 } },
      turnRetry: null,
    })
    expect(turnRetryOf(optedOut)?.on).toEqual([])
    expect(turnRetryOf(optedOut)?.rotate).toBeUndefined()

    // Without the explicit null the preset's policy still lands.
    const presetted = await descriptorOf(deps, {
      role: "executor",
      preset: { id: "retry-fast", label: "Retry fast", turnRetry: { on: ["rate-limit"], maxRetries: 3 } },
    })
    expect(turnRetryOf(presetted)).toMatchObject({ on: ["rate-limit"], maxRetries: 3 })
  })
})

describe("agent_start turnRetry default for sandbox agents", () => {
  async function withSandboxDeps() {
    const workspace = await mkdtemp(join(tmpdir(), "agentproto-tr-default-sandbox-"))
    dirs.push(workspace)
    const port = await freePort()
    // The box is a real in-process daemon with the same fake adapter.
    const gateway: GatewayHandle = await createGateway({
      workspace,
      specs: [],
      port,
      boot: false,
      persist: false,
      persistPath: join(workspace, "sessions.json"),
      resolveAgentAdapter: fakeAdapterResolver,
    })
    cleanups.push(async () => {
      await gateway.stop()
    })
    const provider: SandboxProvider = {
      async boot() {
        return { mcpUrl: `${gateway.url}/mcp`, sandboxId: "sbx_tr_default_1", stop: async () => {} }
      },
    }
    const registry = createSessionsRegistry({ persist: false })
    const deps: SpawnAgentSessionDeps = {
      registry,
      resolveAgentAdapter: async () => null,
      resolveSandboxProvider: async slug => {
        if (slug !== "fake") return null
        return {
          provider,
          slug: "fake",
          name: "Fake",
          version: "test",
          description: "test double",
          requiresSetup: false,
          capabilities: { networkEgress: false, mounts: false, lifecyclePause: false, readOnly: false },
          check: async () => true,
          subaccount: undefined,
        }
      },
      loadDefaultsConfig: async () => undefined,
      loadRoleRegistry: async () => ({}),
    }
    cleanups.push(() => Promise.resolve(registry.shutdown()))
    return deps
  }

  it("even a supervisor role gets the default policy when the session runs in a box", async () => {
    const deps = await withSandboxDeps()
    const result = await spawnLocal(deps, { sandbox: "fake" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.descriptor.remote).toBe(true)
    expect(turnRetryOf(result.descriptor)).toMatchObject({
      on: ["rate-limit", "upstream-5xx", "no-output-stall"],
      maxRetries: 6,
    })
  }, 20_000)

  it("an explicit opt-out beats the sandbox default", async () => {
    const deps = await withSandboxDeps()
    const result = await spawnLocal(deps, { sandbox: "fake", turnRetry: null })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(turnRetryOf(result.descriptor)?.on).toEqual([])
  }, 20_000)
})

describe("free stays free — the default rotate list validates at spawn", () => {
  it("defaultTurnRetryForSpawn output passes validateTurnRetryRotate for a free current model", async () => {
    const { defaultTurnRetryForSpawn, validateTurnRetryRotate } = await import("../turn-retry-policy.js")
    const input = defaultTurnRetryForSpawn("opencode/glm-5.3-flash-free")
    expect(validateTurnRetryRotate(input.rotate, "opencode/glm-5.3-flash-free")).toBeUndefined()
    // And an explicit PAID rotate list on a free model is still refused.
    expect(validateTurnRetryRotate([{ model: "claude-sonnet-4-5" }], "opencode/glm-5.3-flash-free")).toBeDefined()
  })

  it("resolveTurnRetryPolicy leaves the default's rotate list intact", async () => {
    const { defaultTurnRetryForSpawn, resolveTurnRetryPolicy } = await import("../turn-retry-policy.js")
    const policy = resolveTurnRetryPolicy(defaultTurnRetryForSpawn("opencode/glm-5.3-flash-free"))
    expect(policy.rotate?.map(t => t.model)).toEqual(
      FREE_ROTATE_IDS.filter(m => m !== "opencode/glm-5.3-flash-free"),
    )
  })

  it("editing default-rotation changes the default rotate list", async () => {
    const { defaultTurnRetryForSpawn } = await import("../turn-retry-policy.js")
    await saveModelList({
      id: DEFAULT_ROTATION_LIST_ID,
      label: "Default rotation targets",
      ids: ["opencode/big-pickle", "opencode/glm-5.3-flash-free"],
    })
    const input = defaultTurnRetryForSpawn("opencode/deepseek-v4.1-flash-free")
    expect(input.rotate?.map(t => t.model)).toEqual([
      "opencode/big-pickle",
      "opencode/glm-5.3-flash-free",
    ])
  })

  it("a default-rotation id outside zero-cost is not used", async () => {
    const { defaultTurnRetryForSpawn } = await import("../turn-retry-policy.js")
    await saveModelList({
      id: DEFAULT_ROTATION_LIST_ID,
      label: "Default rotation targets",
      ids: ["opencode/gpt-5.1-codex", "opencode/big-pickle"],
    })
    const input = defaultTurnRetryForSpawn("opencode/glm-5.3-flash-free")
    expect(input.rotate?.map(t => t.model)).toEqual(["opencode/big-pickle"])
  })
})
