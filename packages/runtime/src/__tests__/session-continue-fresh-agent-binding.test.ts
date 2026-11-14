import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  continueAgentSessionFresh,
  resetContinueFreshMemoForTests,
} from "../session-continue-fresh.js"
import {
  spawnAgentSession,
  type SpawnAgentSessionDeps,
} from "../session-spawn.js"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent, type SessionDescriptor, type SessionsRegistry } from "../sessions.js"
import { cdContractLine } from "../agents-md.js"
import type { OrchestratorScope } from "../orchestrator-gateway.js"

function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: "acp_test",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

function makeDeps(overrides: Partial<SpawnAgentSessionDeps> = {}): {
  registry: SessionsRegistry
  deps: SpawnAgentSessionDeps
} {
  const registry = createSessionsRegistry({ persist: false })
  const startSession = vi.fn(async () => fakeAgentSession())
  const deps: SpawnAgentSessionDeps = {
    registry,
    resolveAgentAdapter: async () => ({
      startSession: startSession as never,
      commandPreview: "mock-adapter",
    }),
    resolveAgentsMd: async () => ({ mode: "absent", contractLine: cdContractLine }),
    resolveWorkspaceRules: async () => ({}),
    loadDefaultsConfig: async () => ({}),
    daemonMcpUrl: "http://127.0.0.1:18790/mcp",
    ...overrides,
  }
  return { registry, deps }
}

async function spawnSource(
  deps: SpawnAgentSessionDeps,
  input: Parameters<typeof spawnAgentSession>[1],
): Promise<SessionDescriptor> {
  const result = await spawnAgentSession(deps, input)
  if (!result.ok) throw new Error(`source spawn failed: ${result.code} ${result.message}`)
  return result.descriptor
}

const PLANNER_ROLE = {
  name: "planner",
  disposition: "You plan work and delegate execution.",
  toolPolicy: { delegation: "allow" as const },
  level: 50,
}

function scopeFor(ownerSessionId: string): OrchestratorScope {
  return {
    token: "tok",
    tools: new Set(["agent_start"]),
    ownerSessionId,
    depth: 0,
    maxDepth: 3,
    maxChildren: 8,
    role: "supervisor",
  }
}

const hasDelegationDenied = (desc: SessionDescriptor): boolean =>
  (desc.mcpServers ?? []).some(
    (entry): boolean => typeof entry.ref === "string" && entry.ref.includes("denyTools=agent_start"),
  )

const TEST_CONTEXT_CONTINUITY = {
  mode: "auto",
  warnAtPct: 55,
  compactAtPct: 65,
  continueFreshAtPct: 75,
  hardStopAtPct: 90,
  goal: true,
  plan: true,
  decisions: true,
  changedFiles: true,
  gitStatus: true,
  tests: true,
  errors: true,
  risks: true,
  nextStep: true,
  config: true,
  label: "auto",
}

let legacySeq = 0

function legacySource(
  meta: Record<string, string> | undefined,
  overrides: Partial<SessionDescriptor> = {},
): SessionDescriptor {
  return {
    id: `sess_legacy_${++legacySeq}`,
    kind: "agent-cli",
    workspaceSlug: "ws",
    command: "claude",
    pid: 1,
    status: "running",
    startedAt: new Date().toISOString(),
    adapterSlug: "claude-code",
    harness: "claude-code",
    cwd: dir,
    contextContinuity: TEST_CONTEXT_CONTINUITY,
    ...(meta ? { meta } : {}),
    ...overrides,
  } as SessionDescriptor
}

let dir: string
let baseDir: string

beforeEach(() => {
  resetContinueFreshMemoForTests()
  dir = mkdtempSync(join(tmpdir(), "agp-continue-fresh-binding-"))
  baseDir = mkdtempSync(join(tmpdir(), "agp-continue-fresh-checkpoints-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(baseDir, { recursive: true, force: true })
})

function writeManifest(id: string, extra: string[] = []): void {
  const agentDir = join(dir, ".agents", id)
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    join(agentDir, "AGENT.md"),
    [
      "---",
      "schema: agent/v1",
      `id: ${id}`,
      "description: probe",
      "model: test-model",
      ...extra,
      "---",
      "",
      `You are ${id}.`,
    ].join("\n"),
    "utf8",
  )
}

describe("continueAgentSessionFresh carries the source's agent binding", () => {
  it("A: a source bound to the built-in executor keeps its role and delegation deny", async () => {
    const { deps } = makeDeps()
    const source = legacySource({ role: "executor" })

    const result = await continueAgentSessionFresh(deps, source, {
      baseDir,
      askSource: false,
    })

    expect(result.descriptor.meta?.role).toBe("executor")
    expect(result.descriptor.meta?.agentSlug).toBe("executor")
    expect(hasDelegationDenied(result.descriptor)).toBe(true)
  })

  it("A2: a source really spawned on a pack role keeps it, not the default agent", async () => {
    const { deps } = makeDeps({ loadRoleRegistry: async () => ({ planner: PLANNER_ROLE }) })
    const source = await spawnSource(deps, { adapter: "mock", cwd: dir, role: "planner" })
    expect(source.meta?.role).toBe("planner")

    const result = await continueAgentSessionFresh(deps, source, {
      baseDir,
      askSource: false,
    })

    expect(result.descriptor.meta?.role).toBe("planner")
    expect(result.descriptor.meta?.agentSlug).toBe("planner")
  })

  it("B: a manifest agent keeps its id and frozen delegates_to, and the gate enforces them", async () => {
    writeManifest("manifest-caller", ["delegates_to:", "  - executor"])
    const { deps } = makeDeps()
    const source = await spawnSource(deps, { adapter: "mock", cwd: dir, agentId: "manifest-caller" })
    expect(source.meta?.agentSlug).toBe("manifest-caller")
    expect(source.meta?.agentDelegatesTo).toBe("executor")

    const result = await continueAgentSessionFresh(deps, source, {
      baseDir,
      askSource: false,
    })
    expect(result.descriptor.meta?.agentSlug).toBe("manifest-caller")
    expect(result.descriptor.meta?.agentDelegatesTo).toBe("executor")

    const enforceDeps: SpawnAgentSessionDeps = {
      ...deps,
      loadDefaultsConfig: async () => ({ spawn: { delegationGate: "enforce" } }),
      loadRoleRegistry: async () => ({ planner: PLANNER_ROLE }),
    }
    const refused = await spawnAgentSession(
      { ...enforceDeps, callerScope: scopeFor(result.descriptor.id) },
      { adapter: "mock", cwd: dir, role: "planner" },
    )
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error("expected refusal")
    expect(refused.code).toBe("delegation_denied")
    expect(refused.details).toMatchObject({
      gate: "agent",
      callerAgent: "manifest-caller",
      childAgent: "planner",
      delegatesTo: ["executor"],
    })
  })

  it("C: a memory opt-out rides along and an ordinary source gains no memory key", async () => {
    const { registry, deps } = makeDeps()
    const off = await spawnSource(deps, { adapter: "mock", cwd: dir, role: "executor" })
    registry.mergeMeta(off.id, { memory: "disabled" })

    const continuedOff = await continueAgentSessionFresh(deps, off, {
      baseDir,
      askSource: false,
    })
    expect(continuedOff.descriptor.meta?.memory).toBe("disabled")

    const on = await spawnSource(deps, { adapter: "mock", cwd: dir, role: "executor" })
    const continuedOn = await continueAgentSessionFresh(deps, on, {
      baseDir,
      askSource: false,
    })
    expect(continuedOn.descriptor.meta ?? {}).not.toHaveProperty("memory")
  })

  it("D: an explicit role in the continuation request wins and nothing is carried", async () => {
    writeManifest("manifest-caller", ["delegates_to:", "  - executor"])
    const { deps } = makeDeps()
    const source = await spawnSource(deps, { adapter: "mock", cwd: dir, agentId: "manifest-caller" })

    const result = await continueAgentSessionFresh(deps, source, {
      baseDir,
      askSource: false,
      spawn: { role: "executor" },
    })

    expect(result.descriptor.meta?.role).toBe("executor")
    expect(result.descriptor.meta?.agentSlug).toBe("executor")
    expect(result.descriptor.meta?.agentDelegatesTo).toBeUndefined()
  })

  it("D2: an explicit agent in the continuation request wins too", async () => {
    writeManifest("manifest-caller", ["delegates_to:", "  - executor"])
    const { deps } = makeDeps()
    const source = await spawnSource(deps, { adapter: "mock", cwd: dir, agentId: "manifest-caller" })

    const result = await continueAgentSessionFresh(deps, source, {
      baseDir,
      askSource: false,
      spawn: { agent: "executor" },
    })

    expect(result.descriptor.meta?.agentSlug).toBe("executor")
    expect(result.descriptor.meta?.agentDelegatesTo).toBeUndefined()
  })

  it("E: an older source with no binding meta is unchanged", async () => {
    const { deps } = makeDeps()
    const result = await continueAgentSessionFresh(deps, legacySource(undefined), {
      baseDir,
      askSource: false,
    })

    expect(result.descriptor.meta?.role).toBe("supervisor")
    expect(result.descriptor.meta?.agentSlug).toBe("supervisor")
    expect(result.descriptor.meta ?? {}).not.toHaveProperty("agentDelegatesTo")
    expect(result.descriptor.meta ?? {}).not.toHaveProperty("memory")
  })

  it("F: the picking function takes only the binding keys from the source meta", async () => {
    const mod = (await import("../session-continue-fresh.js")) as unknown as {
      pickAgentBindingMeta?: (meta: Readonly<Record<string, string>> | undefined) => Record<string, string>
    }
    expect(typeof mod.pickAgentBindingMeta).toBe("function")
    const picked = mod.pickAgentBindingMeta?.({
      role: "executor",
      agentSlug: "manifest-caller",
      agentDelegatesTo: "executor,planner",
      memory: "disabled",
      memoryInject: "native-dir",
      memoryAnchors: "agent:scout",
      memoryCapture: "native-dir-diff",
      memoryStoreRoot: "/tmp/store",
      agentId: "manifest-caller",
    })
    expect(picked).toEqual({
      role: "executor",
      agentSlug: "manifest-caller",
      agentDelegatesTo: "executor,planner",
      memory: "disabled",
    })

    const partial = mod.pickAgentBindingMeta?.({
      role: "",
      agentSlug: "manifest-caller",
      memory: "enabled",
      memoryInject: "native-dir",
    })
    expect(partial).toEqual({ agentSlug: "manifest-caller" })
    expect(mod.pickAgentBindingMeta?.(undefined)).toEqual({})
  })
})
