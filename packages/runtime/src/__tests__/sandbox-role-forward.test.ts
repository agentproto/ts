/**
 * Role enforcement across the sandbox boundary: the spawn-time role the
 * HOST resolves rides onto the BOX's own `agent_start` (`role`), so the box
 * daemon enforces the executor/supervisor delegation rule consistently —
 * its own self-mount gets the same `?denyTools=` stripping a host spawn
 * would instead of re-resolving the role from nothing executor-side.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const hostStarts: Array<Record<string, unknown>> = []
vi.mock("@agentproto/sandbox", async importOriginal => {
  const actual = await importOriginal<typeof import("@agentproto/sandbox")>()
  const fakeHost: Record<string, unknown> = {
    sandboxId: "sbx_role_test",
    start: async (args: Record<string, unknown>) => {
      hostStarts.push(args)
      return { id: "sess_box_role", status: "idle", startedAt: "2026-01-01T00:00:00.000Z" }
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

import { bootSandboxAgentSession } from "../session-spawn.js"
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

describe("agent_start sandbox — the spawn-time role is forwarded to the box daemon", () => {
  let base: string
  beforeEach(() => {
    hostStarts.length = 0
    base = join(mkdtempSync(join(tmpdir(), "sandbox-role-")), "sessions")
    setDefaultSessionsBaseDir(base)
    return () => setDefaultSessionsBaseDir(undefined)
  })

  it("role forwarded for the BOX's own agent_start to enforce", async () => {
    const booted = await bootSandboxAgentSession({
      sandbox: "fake",
      adapter: "fake-cli",
      cwd: "/tmp",
      explicitCwd: true,
      role: "executor",
      resolveSandboxProvider: vi.fn(async () => handle),
    })
    expect(booted.ok).toBe(true)
    if (!booted.ok) throw new Error(`expected boot success: ${JSON.stringify(booted)}`)
    expect(hostStarts).toHaveLength(1)
    expect(hostStarts[0]?.role).toBe("executor")
  })

  it("no role forwarded → the box spawn args carry none (unchanged shape)", async () => {
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
    expect(hostStarts[0]?.role).toBeUndefined()
  })
})
