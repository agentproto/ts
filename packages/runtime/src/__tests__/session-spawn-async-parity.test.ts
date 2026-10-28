/**
 * E77: the async worktree branch of `spawnAgentSession` (the default for
 * worktree spawns since WP-H) must start the driver and record the
 * descriptor exactly like the synchronous branch does for the same input.
 * It used to build its own `startSession` literal and its own `meta`, and
 * drifted: no env (E75), the raw `resumeSessionId` with a fresh config dir
 * instead of the resolved resume target, and none of the agent identity or
 * `meta.cloud` a restart reads back. Both branches now go through one
 * builder; these tests compare the two calls on the same input so a field
 * added to one branch only fails here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnAgentSession, type SpawnAgentSessionDeps, type SpawnAgentSessionInput } from "../session-spawn.js"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent, type SessionsRegistry } from "../sessions.js"
import { restartAgentSession } from "../session-restart-core.js"
import { buildAppBoundary } from "../app-boundary.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { WorktreeIsolationMode } from "../worktree-isolation.js"

let root: string
let previousHome: string | undefined

beforeEach(async () => {
  previousHome = process.env.HOME
  root = await mkdtemp(join(tmpdir(), "agp-async-parity-"))
  process.env.HOME = root
  await mkdir(join(root, "repo"), { recursive: true })
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await rm(root, { recursive: true, force: true })
})

function fakeAgentSession(id = "acp_test"): AgentSessionLike {
  return {
    sessionId: id,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

interface Harness {
  registry: SessionsRegistry
  starts: Array<Record<string, unknown>>
  deps: SpawnAgentSessionDeps
}

function harness(caps: Record<string, unknown> = {}, mode: WorktreeIsolationMode = "on-request"): Harness {
  const registry = createSessionsRegistry({ persist: false })
  const starts: Array<Record<string, unknown>> = []
  const resolveAgentAdapter: AgentAdapterResolver = async () => ({
    startSession: (async (opts: Record<string, unknown>) => {
      starts.push(opts)
      return fakeAgentSession()
    }) as never,
    commandPreview: "mock-adapter",
    ...caps,
  })
  const deps: SpawnAgentSessionDeps = {
    registry,
    resolveAgentAdapter,
    resolveAgentsMd: async () => ({ mode: "absent", contractLine: "" }),
    resolveWorkspaceRules: async () => ({}),
    resolveProvenanceWrapGh: async () => false,
    resolveWorktreeIsolation: async () => mode,
    provisionWorktree: vi.fn(async () => ({
      isolated: true as const,
      cwd: join(root, "wt"),
      branch: "wt/parity",
    })),
  }
  return { registry, starts, deps }
}

/** Spawn the same input once per branch and return both start calls and
 *  descriptors, each with its own minted session id replaced by `<id>` so
 *  the two can be compared value for value. */
async function spawnOnBothBranches(
  input: SpawnAgentSessionInput,
  prepare: (registry: SessionsRegistry) => Partial<SpawnAgentSessionInput> = () => ({}),
) {
  const run = async (async: boolean) => {
    const h = harness()
    const result = await spawnAgentSession(h.deps, {
      ...input,
      ...prepare(h.registry),
      worktree: { async },
    })
    if (!result.ok) throw new Error(`spawn failed: ${result.message}`)
    const id = result.descriptor.id
    await vi.waitFor(() => expect(h.registry.get(id)?.status).toBe("running"))
    expect(h.starts).toHaveLength(1)
    const normalize = (v: unknown) => JSON.parse(JSON.stringify(v).replaceAll(id, "<id>"))
    const start = h.starts[0]!
    return {
      h,
      id,
      start,
      startKeys: Object.keys(start).sort(),
      startNormalized: normalize(start),
      meta: normalize(h.registry.get(id)?.meta),
    }
  }
  return { sync: await run(false), async: await run(true) }
}

async function writeAgent(): Promise<string> {
  const dir = join(root, "repo", ".agents", "scout")
  await mkdir(dir, { recursive: true })
  const path = join(dir, "AGENT.md")
  await writeFile(
    path,
    ["---", "schema: agent/v1", "id: scout", "description: Agent scout", "model: test-model", "---", "", "You are scout.", ""].join("\n"),
    "utf8",
  )
  return path
}

describe("spawnAgentSession: async worktree branch parity with the synchronous branch (E77)", () => {
  it("hands the driver the same start options, keys and values, as a synchronous worktree spawn", async () => {
    const { sync, async } = await spawnOnBothBranches({
      adapter: "mock",
      cwd: join(root, "repo"),
      workspaceSlug: "ws",
      prompt: "go",
      effort: "high",
      mode: "auto",
    })
    expect(sync.start.cwd).toBe(join(root, "wt"))
    expect(async.startKeys).toEqual(sync.startKeys)
    expect(async.startNormalized).toEqual(sync.startNormalized)
  })

  it("resolves a resume target the same way: the row's adapter conversation and its config dir", async () => {
    const prepare = (registry: SessionsRegistry) => {
      const prev = registry.spawnAgent({
        id: "sess_prevrow",
        workspaceSlug: "ws",
        cwd: join(root, "repo"),
        agentSession: fakeAgentSession("acp_prev_conversation"),
        adapterSlug: "mock",
        adapterConfigDir: join(root, "cfg-prev"),
      })
      registry.kill(prev.id)
      return { resumeSessionId: prev.id }
    }
    const { sync, async } = await spawnOnBothBranches(
      { adapter: "mock", cwd: join(root, "repo"), workspaceSlug: "ws" },
      prepare,
    )
    expect(sync.start.resumeSessionId).toBe("acp_prev_conversation")
    expect(sync.start.configDir).toBe(join(root, "cfg-prev"))
    expect(async.startNormalized).toEqual(sync.startNormalized)
    // The resume was accepted: both rows claim the same continuity.
    expect(async.h.registry.get(async.id)?.resumedFrom).toBe("sess_prevrow")
    expect(async.h.registry.get(async.id)?.resumeVia).toBe(sync.h.registry.get(sync.id)?.resumeVia)
  })

  it("records the same descriptor meta, including the agent identity the gateway and role refresh read", async () => {
    const agentPath = await writeAgent()
    const { sync, async } = await spawnOnBothBranches({
      adapter: "mock",
      cwd: join(root, "repo"),
      workspaceSlug: "ws",
      prompt: "go",
      agentPath,
    })
    expect(sync.meta).toMatchObject({ agentId: "scout", agentManifestPath: agentPath })
    expect(async.meta).toEqual(sync.meta)
  })
})

describe("restart of an async worktree session re-applies what the spawn recorded (E77)", () => {
  // `session_restart` re-derives the driver's boundary from the prior row:
  // `meta.appBoundary` (fs zones + host-context isolation), the effective
  // `commandSandbox`, `permissionHold`, the config dir, the system-prompt
  // text. A session spawned through the async branch must restart with the
  // same options as one spawned through the synchronous branch.
  it("restarts with the same start options as a synchronously spawned session", async () => {
    const restartArgs: Record<string, Record<string, unknown>> = {}
    const { sync, async } = await spawnOnBothBranches({
      adapter: "mock",
      cwd: join(root, "repo"),
      workspaceSlug: "ws",
      commandSandbox: "workspace",
      permissionHold: true,
      appendSystemPrompt: "stay in the worktree",
    })
    for (const [branch, run] of Object.entries({ sync, async })) {
      const starts: Array<Record<string, unknown>> = []
      const resolver: AgentAdapterResolver = async () => ({
        startSession: (async (opts: Record<string, unknown>) => {
          starts.push(opts)
          return fakeAgentSession("acp_restarted")
        }) as never,
        commandPreview: "mock-adapter",
        supportsSystemPrompt: true,
      })
      const prev = run.h.registry.get(run.id)!
      const restarted = await restartAgentSession(run.h.registry, resolver, prev, {
        loadDefaultsConfig: async () => ({}),
      })
      expect(starts).toHaveLength(1)
      restartArgs[branch] = JSON.parse(
        JSON.stringify(starts[0]).replaceAll(restarted.desc.id, "<new>").replaceAll(run.id, "<id>"),
      )
    }
    expect(restartArgs.sync).toMatchObject({ cwd: join(root, "wt"), permissionHold: true })
    expect(restartArgs.async).toEqual(restartArgs.sync)
  })
})

describe("app boundary vs worktree spawns (E77)", () => {
  // The fs zones and host-context isolation come only from an app boundary,
  // and an app-boundaried spawn never reaches either worktree branch. These
  // pin that precondition: if it ever changes, the shared start-options
  // builder already carries the zones on the async branch too.
  function boundary() {
    const appDir = join(root, "app")
    return buildAppBoundary({
      app: { appId: "@test/app", dir: appDir, dataDir: join(appDir, "data") },
      runWorkspace: join(root, "run"),
      daemonWorkspace: join(root, "repo"),
    })
  }

  it("refuses an explicit worktree, async or not, for an app-boundaried spawn", async () => {
    for (const async of [true, false]) {
      const h = harness({ supportsFsZones: true, supportsHostContextIsolation: true })
      const result = await spawnAgentSession(h.deps, {
        adapter: "mock",
        cwd: join(root, "app"),
        appBoundary: boundary(),
        worktree: { async },
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe("app_boundary_worktree")
      expect(h.deps.provisionWorktree).not.toHaveBeenCalled()
      expect(h.starts).toHaveLength(0)
    }
  })

  it("an \"always\" worktree policy never provisions an app-boundaried spawn, which keeps its host-context isolation", async () => {
    const h = harness({ supportsHostContextIsolation: true }, "always")
    const result = await spawnAgentSession(h.deps, { adapter: "mock", appBoundary: boundary() })
    if (!result.ok) throw new Error(`spawn failed: ${result.message}`)
    expect(h.deps.provisionWorktree).not.toHaveBeenCalled()
    expect(h.starts[0]?.isolateHostContext).toBe(true)
    expect(h.starts[0]?.cwd).toBe(join(root, "app"))
  })
})
