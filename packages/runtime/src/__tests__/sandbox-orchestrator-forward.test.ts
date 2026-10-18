/**
 * `agent_start({ sandbox, orchestrator })` — nested orchestration across the
 * sandbox boundary (regression for the host-loopback /mcp/orchestrator mount).
 *
 * The HOST daemon's scoped `/mcp/orchestrator?scope=…` mount points at the
 * host's own loopback, which a remote box (e2b/Box) can never reach. The
 * CORRECT mechanism is NOT to inject that URL (or worse, mint a scope token
 * nobody can use) — it is to hand the `orchestrator` request to the BOX's
 * own `agentproto serve` daemon (reached via the sandbox session host), which
 * mints the scope and mounts `/mcp/orchestrator` on ITS loopback — reachable
 * by the adapter process inside the box. This test pins the seam: the inner
 * `host.start()` args carry the forwarded `orchestrator` request, and the
 * HOST injects no `/mcp/orchestrator` entry at all.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const hostStarts: Array<Record<string, unknown>> = []
vi.mock("@agentproto/sandbox", async importOriginal => {
  const actual = await importOriginal<typeof import("@agentproto/sandbox")>()
  const fakeHost: Record<string, unknown> = {
    sandboxId: "sbx_orch_test",
    start: async (args: Record<string, unknown>) => {
      hostStarts.push(args)
      return { id: "sess_box_orch", status: "idle", startedAt: "2026-01-01T00:00:00.000Z" }
    },
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
    stop: async () => {},
    close: async () => {},
  }
  return {
    ...actual,
    createSandboxAgentSessionHost: vi.fn(async () => fakeHost),
  }
})
vi.mock("../sandbox-agent-session-proxy.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../sandbox-agent-session-proxy.js")>()
  return {
    ...actual,
    createSandboxAgentSessionProxy:
      (() => ({ send: async () => ({}), cancel: async () => {}, close: async () => {} })) as unknown as typeof actual.createSandboxAgentSessionProxy,
  }
})

import {
  bootSandboxAgentSession,
  narrowSandboxOrchestratorForward,
} from "../session-spawn.js"
import type { OrchestratorScope } from "../orchestrator-gateway.js"
import { setDefaultSessionsBaseDir } from "../transcript-writer.js"

const handle = {
  provider: {
    async connect() {
      throw new Error("not expected")
    },
    async boot() {
      throw new Error("not expected")
    },
  },
  slug: "fake",
  name: "Fake",
  version: "test",
  description: "test double",
  requiresSetup: false,
  capabilities: { networkEgress: false, mounts: false, lifecyclePause: false, readOnly: false },
  async check() {
    return true
  },
} as unknown as Parameters<typeof bootSandboxAgentSession>[0]["resolveSandboxProvider"] extends (
  slug: string,
) => infer R
  ? Awaited<R>
  : never

describe("agent_start sandbox — orchestrator forwarded to the box daemon", () => {
  let base: string
  beforeEach(() => {
    hostStarts.length = 0
    base = join(mkdtempSync(join(tmpdir(), "sandbox-orch-")), "sessions")
    setDefaultSessionsBaseDir(base)
    return () => setDefaultSessionsBaseDir(undefined)
  })

  it("orchestrator:true → forwarded verbatim to the box's own agent_start; no unreachable host mount", async () => {
    const booted = await bootSandboxAgentSession({
      sandbox: "fake",
      adapter: "fake-cli",
      cwd: "/tmp",
      explicitCwd: true,
      orchestrator: true,
      resolveSandboxProvider: vi.fn(async () => handle),
    })
    expect(booted.ok).toBe(true)
    if (!booted.ok) throw new Error(`expected boot success: ${JSON.stringify(booted)}`)
    expect(hostStarts).toHaveLength(1)
    expect(hostStarts[0]?.orchestrator).toBe(true)
    expect(hostStarts[0]?.adapter).toBe("fake-cli")
  })

  it("orchestrator:{tools,maxDepth,maxChildren} → forwarded object-form onto the box", async () => {
    const booted = await bootSandboxAgentSession({
      sandbox: "fake",
      adapter: "fake-cli",
      cwd: "/tmp",
      explicitCwd: true,
      orchestrator: { tools: ["agent_start"], maxDepth: 2, maxChildren: 3 },
      resolveSandboxProvider: vi.fn(async () => handle),
    })
    expect(booted.ok).toBe(true)
    if (!booted.ok) throw new Error(`expected boot success: ${JSON.stringify(booted)}`)
    expect(hostStarts).toHaveLength(1)
    expect(hostStarts[0]?.orchestrator).toEqual({
      tools: ["agent_start"],
      maxDepth: 2,
      maxChildren: 3,
    })
  })

  it("no orchestrator request → the box spawn args carry none (unchanged shape)", async () => {
    const booted = await bootSandboxAgentSession({
      sandbox: "fake",
      adapter: "fake-cli",
      cwd: "/tmp",
      explicitCwd: true,
      resolveSandboxProvider: vi.fn(async () => handle),
    })
    expect(booted.ok).toBe(true)
    if (!booted.ok) throw new Error(`expected boot success: ${JSON.stringify(booted)}`)
    expect(hostStarts).toHaveLength(1)
    expect(hostStarts[0]?.orchestrator).toBeUndefined()
  })

  it("narrowSandboxOrchestratorForward — a scoped (callerScope) controller's ceiling travels to the box, never widens", () => {
    const callerScope: OrchestratorScope = {
      token: "tok_parent",
      tools: new Set(["agent_start", "task_list"]),
      ownerSessionId: "sess_parent",
      depth: 1,
      maxDepth: 4,
      maxChildren: 10,
      role: "supervisor",
    }
    // Bare `true` from a scoped caller → expanded to the CALLER ceiling (not
    // the box's default), so the box can't mint a broader scope than the
    // parent holds.
    expect(narrowSandboxOrchestratorForward(true, callerScope)).toEqual({
      tools: ["agent_start", "task_list"],
      maxDepth: 4,
      maxChildren: 10,
    })
    // Requested ⊆ caller ceiling is preserved.
    expect(
      narrowSandboxOrchestratorForward(
        { tools: ["task_list"], maxDepth: 6, maxChildren: 20 },
        callerScope,
      ),
    ).toEqual({ tools: ["task_list"], maxDepth: 4, maxChildren: 10 })
    // Off-ceiling requests are intersected/clamped (requested ∩ ceiling).
    expect(
      narrowSandboxOrchestratorForward(
        { tools: ["agent_start", "task_create"], maxDepth: 2 },
        callerScope,
      ),
    ).toEqual({ tools: ["agent_start"], maxDepth: 2, maxChildren: 10 })
    // Root spawn (no callerScope): passes through, box keeps its defaults.
    expect(narrowSandboxOrchestratorForward(true)).toBe(true)
    expect(
      narrowSandboxOrchestratorForward({ tools: ["agent_start"], maxDepth: 2 }),
    ).toEqual({ tools: ["agent_start"], maxDepth: 2 })
  })
})
