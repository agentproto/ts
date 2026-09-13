import { describe, it, expect, vi, beforeEach } from "vitest"
import { continueAgentSessionFresh } from "../session-continue-fresh.js"
import type { SessionDescriptor } from "../sessions.js"
import type { SpawnAgentSessionDeps } from "../session-spawn.js"

vi.mock("../session-spawn.js", async importOriginal => {
  const mod = await importOriginal<typeof import("../session-spawn.js")>()
  return {
    ...mod,
    spawnAgentSession: vi.fn(),
  }
})

import { spawnAgentSession } from "../session-spawn.js"

const makePrev = (): SessionDescriptor =>
  ({
    id: "sess_prev",
    kind: "agent-cli",
    workspaceSlug: "ws",
    command: "claude",
    pid: 123,
    status: "running",
    startedAt: new Date().toISOString(),
    adapterSlug: "claude-code",
    harness: "claude-code",
    model: "claude-sonnet-5",
    effort: "high",
    posture: "default",
    contextProfile: "full",
    cwd: "/tmp/repo",
    route: { gateway: "anthropic" },
    accessProfile: { profileRef: "anthropic-main", label: "Main", endpoint: "anthropic", method: "oauth-bearer" },
    contextContinuity: {
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
    },
  }) as SessionDescriptor

const fakeRegistry = {
  get: vi.fn(),
} as unknown as SpawnAgentSessionDeps["registry"]

const fakeResolveAdapter = vi.fn()

describe("continueAgentSessionFresh", () => {
  beforeEach(() => {
    vi.mocked(spawnAgentSession).mockReset()
    vi.mocked(fakeResolveAdapter).mockReset()
    fakeRegistry.get = vi.fn()
  })

  it("spawns a new session without resumeSessionId", async () => {
    const prev = makePrev()
    vi.mocked(spawnAgentSession).mockResolvedValue({
      ok: true,
      descriptor: { id: "sess_new" } as SessionDescriptor,
    })

    await continueAgentSessionFresh(
      { registry: fakeRegistry, resolveAgentAdapter: fakeResolveAdapter },
      prev,
      { baseDir: "/tmp/checkpoints" },
    )

    expect(spawnAgentSession).toHaveBeenCalledOnce()
    const [, input] = vi.mocked(spawnAgentSession).mock.calls[0]!
    expect(input.adapter).toBe("claude-code")
    expect(input.harness).toBe("claude-code")
    expect(input.model).toBe("claude-sonnet-5")
    expect(input.effort).toBe("high")
    expect(input.route).toEqual({ gateway: "anthropic" })
    expect(input.access).toEqual({ profileRef: "anthropic-main" })
    expect(input.posture).toBe("default")
    expect(input.cwd).toBe("/tmp/repo")
    expect(input.resumeSessionId).toBeUndefined()
    expect(input.prompt).toContain("[continued session")
  })

  it("strips the retired session's own callerSessionId stamp from carried mcpServers so the spawn re-stamps with the fresh id", async () => {
    // The spawn path respects an entry that already carries a
    // callerSessionId — copying prev's stamped mount verbatim would pin the
    // NEW session's outbound identity (and its children's auto-attach
    // lineage) to the dead id. Only OUR stale stamp is stripped: a foreign
    // pin someone set on purpose, non-daemon entries, and stdio entries all
    // ride through untouched.
    const prev = makePrev()
    prev.mcpServers = [
      {
        name: "agentproto",
        transport: "http",
        ref: "http://127.0.0.1:18790/mcp?callerSessionId=sess_prev",
      },
      {
        name: "pinned",
        transport: "http",
        ref: "http://127.0.0.1:18790/mcp?callerSessionId=someone-else",
      },
      { name: "local", transport: "stdio", ref: "some-command" },
    ]
    vi.mocked(spawnAgentSession).mockResolvedValue({
      ok: true,
      descriptor: { id: "sess_new" } as SessionDescriptor,
    })

    await continueAgentSessionFresh(
      { registry: fakeRegistry, resolveAgentAdapter: fakeResolveAdapter },
      prev,
      { baseDir: "/tmp/checkpoints" },
    )

    const [, input] = vi.mocked(spawnAgentSession).mock.calls[0]!
    expect(input.mcpServers).toEqual([
      { name: "agentproto", transport: "http", ref: "http://127.0.0.1:18790/mcp" },
      {
        name: "pinned",
        transport: "http",
        ref: "http://127.0.0.1:18790/mcp?callerSessionId=someone-else",
      },
      { name: "local", transport: "stdio", ref: "some-command" },
    ])
  })

  it("links provenance both ways", async () => {
    const prev = makePrev()
    const newDesc = { id: "sess_new" } as SessionDescriptor
    vi.mocked(spawnAgentSession).mockResolvedValue({
      ok: true,
      descriptor: newDesc,
    })

    const result = await continueAgentSessionFresh(
      { registry: fakeRegistry, resolveAgentAdapter: fakeResolveAdapter },
      prev,
      { baseDir: "/tmp/checkpoints" },
    )

    expect(result.continuedFrom).toBe("sess_prev")
    expect(newDesc.continuedFrom).toBe("sess_prev")
    expect(newDesc.checkpointId).toBeDefined()
  })

  it("throws when spawn fails", async () => {
    const prev = makePrev()
    vi.mocked(spawnAgentSession).mockResolvedValue({
      ok: false,
      code: "agent_spawn_failed",
      message: "adapter died",
    })

    await expect(
      continueAgentSessionFresh(
        { registry: fakeRegistry, resolveAgentAdapter: fakeResolveAdapter },
        prev,
      ),
    ).rejects.toThrow("agent_spawn_failed")
  })

  it("throws when no adapter resolver is configured", async () => {
    const prev = makePrev()
    await expect(
      continueAgentSessionFresh(
        { registry: fakeRegistry } as unknown as SpawnAgentSessionDeps,
        prev,
      ),
    ).rejects.toThrow("no adapter resolver")
  })
})
