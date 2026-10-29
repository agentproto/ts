import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  CONTINUED_SOURCES_MAX,
  continueAgentSessionFresh,
  resetContinueFreshMemoForTests,
} from "../session-continue-fresh.js"
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

// Unique id per call: continue-fresh is memoised per source id, so tests must
// not share a source.
let prevSeq = 0
const makePrev = (): SessionDescriptor =>
  ({
    id: `sess_prev_${++prevSeq}`,
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
  markRetired: vi.fn(),
  setPromptPolicy: vi.fn(),
  setOperator: vi.fn(),
} as unknown as SpawnAgentSessionDeps["registry"]

const wireMarkRetired = (): void => {
  fakeRegistry.markRetired = vi.fn((id: string, opts?: { continuedTo?: string }) => {
    const d = fakeRegistry.get(id)
    if (d && opts?.continuedTo) d.continuedTo = opts.continuedTo
    return d
  })
}

const fakeResolveAdapter = vi.fn()

describe("continueAgentSessionFresh", () => {
  beforeEach(() => {
    resetContinueFreshMemoForTests()
    vi.mocked(spawnAgentSession).mockReset()
    vi.mocked(fakeResolveAdapter).mockReset()
    fakeRegistry.get = vi.fn()
    fakeRegistry.setPromptPolicy = vi.fn()
    fakeRegistry.setOperator = vi.fn()
    wireMarkRetired()
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

  it("carries the agent-level clerk hook config onto the fresh session", async () => {
    const prev = { ...makePrev(), clerkHook: { enabled: true, debounceMs: 60_000 } } as SessionDescriptor
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
    expect(input.hooks).toEqual({ clerk: { enabled: true, debounceMs: 60_000 } })
  })

  it("threads notes and the handoff turn into the checkpoint prompt of the fresh session", async () => {
    const prev = makePrev()
    vi.mocked(spawnAgentSession).mockResolvedValue({
      ok: true,
      descriptor: { id: "sess_new" } as SessionDescriptor,
    })
    const handoffAsker = vi.fn(async () =>
      JSON.stringify({ decisions: ["Use the v2 endpoint"], nextStep: "Run the migration" }),
    )

    const result = await continueAgentSessionFresh(
      { registry: fakeRegistry, resolveAgentAdapter: fakeResolveAdapter },
      prev,
      { baseDir: "/tmp/checkpoints", notes: "Do not touch the billing module.", handoffAsker },
    )

    const [, input] = vi.mocked(spawnAgentSession).mock.calls[0]!
    expect(input.prompt).toContain("Do not touch the billing module.")
    expect(input.prompt).toContain("- Use the v2 endpoint")
    expect(input.prompt).toContain("Run the migration")
    expect(result.checkpoint.schemaVersion).toBe(1)
    expect(result.checkpoint.handoffTurn).toEqual({ status: "answered" })
  })

  it("does not ask the source session when askSource is false", async () => {
    const handoffAsker = vi.fn(async () => "{}")
    vi.mocked(spawnAgentSession).mockResolvedValue({
      ok: true,
      descriptor: { id: "sess_new" } as SessionDescriptor,
    })
    await continueAgentSessionFresh(
      { registry: fakeRegistry, resolveAgentAdapter: fakeResolveAdapter },
      makePrev(),
      { baseDir: "/tmp/checkpoints", askSource: false, handoffAsker },
    )
    expect(handoffAsker).not.toHaveBeenCalled()
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
        ref: `http://127.0.0.1:18790/mcp?callerSessionId=${prev.id}`,
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

  it("keeps the previous label and title verbatim (only a legacy (continued) tail is stripped)", async () => {
    const prev = makePrev()
    prev.label = "pm-agentproto (continued)"
    prev.title = "Fixing the billing module"
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
    expect(input.label).toBe("pm-agentproto")
    expect(input.title).toBe("Fixing the billing module")
  })

  it("stamps continuationGeneration: prev's generation + 1, or 1 from a base row", async () => {
    const base = makePrev()
    const baseNew = { id: "sess_new" } as SessionDescriptor
    vi.mocked(spawnAgentSession).mockResolvedValue({ ok: true, descriptor: baseNew })
    const first = await continueAgentSessionFresh(
      { registry: fakeRegistry, resolveAgentAdapter: fakeResolveAdapter },
      base,
      { baseDir: "/tmp/checkpoints" },
    )
    expect(first.descriptor.continuationGeneration).toBe(1)

    // A second generation continues the count instead of resetting to 1.
    const secondPrev = first.descriptor
    secondPrev.contextContinuity = base.contextContinuity
    vi.mocked(spawnAgentSession).mockReset()
    vi.mocked(spawnAgentSession).mockResolvedValue({ ok: true, descriptor: { id: "sess_new2" } as SessionDescriptor })
    const second = await continueAgentSessionFresh(
      { registry: fakeRegistry, resolveAgentAdapter: fakeResolveAdapter },
      secondPrev,
      { baseDir: "/tmp/checkpoints" },
    )
    expect(second.descriptor.continuationGeneration).toBe(2)
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

    expect(result.continuedFrom).toBe(prev.id)
    expect(newDesc.continuedFrom).toBe(prev.id)
    expect(newDesc.checkpointId).toBeDefined()
  })

  it("carries allowPromptFrom forward to the fresh session's new id", async () => {
    const prev = {
      ...makePrev(),
      allowPromptFrom: ["sess_peer", "label:pygmalion-brain-persistent"],
    } as SessionDescriptor
    vi.mocked(spawnAgentSession).mockResolvedValue({
      ok: true,
      descriptor: { id: "sess_new" } as SessionDescriptor,
    })

    await continueAgentSessionFresh(
      { registry: fakeRegistry, resolveAgentAdapter: fakeResolveAdapter },
      prev,
      { baseDir: "/tmp/checkpoints" },
    )

    expect(fakeRegistry.setPromptPolicy).toHaveBeenCalledWith("sess_new", [
      "sess_peer",
      "label:pygmalion-brain-persistent",
    ])
  })

  it("copies operator and operatorDigest from the source row onto the fresh session (AIP-46 operator binding, rule 5)", async () => {
    const prev = {
      ...makePrev(),
      operator: "operator:cto",
      operatorDigest: "sha256:aaa",
    } as SessionDescriptor
    vi.mocked(spawnAgentSession).mockResolvedValue({
      ok: true,
      descriptor: { id: "sess_new" } as SessionDescriptor,
    })

    await continueAgentSessionFresh(
      { registry: fakeRegistry, resolveAgentAdapter: fakeResolveAdapter },
      prev,
      { baseDir: "/tmp/checkpoints" },
    )

    expect(fakeRegistry.setOperator).toHaveBeenCalledWith("sess_new", "operator:cto", "sha256:aaa")
    // Never read from the request the spawn core receives.
    const [, input] = vi.mocked(spawnAgentSession).mock.calls[0]!
    expect(input.operator).toBeUndefined()
    expect(input.operatorDigest).toBeUndefined()
  })

  it("stamps no operator on the fresh session when the source row has none", async () => {
    vi.mocked(spawnAgentSession).mockResolvedValue({
      ok: true,
      descriptor: { id: "sess_new" } as SessionDescriptor,
    })

    await continueAgentSessionFresh(
      { registry: fakeRegistry, resolveAgentAdapter: fakeResolveAdapter },
      makePrev(),
      { baseDir: "/tmp/checkpoints" },
    )

    expect(fakeRegistry.setOperator).not.toHaveBeenCalled()
  })

  it("stamps handoff with matching from/to harness on a same-harness continuation", async () => {
    const prev = makePrev()
    const newDesc = { id: "sess_new", harness: "claude-code", adapterSlug: "claude-code" } as SessionDescriptor
    vi.mocked(spawnAgentSession).mockResolvedValue({
      ok: true,
      descriptor: newDesc,
    })

    await continueAgentSessionFresh(
      { registry: fakeRegistry, resolveAgentAdapter: fakeResolveAdapter },
      prev,
      { baseDir: "/tmp/checkpoints" },
    )

    expect(newDesc.handoff).toEqual({
      fromHarness: "claude-code",
      toHarness: "claude-code",
      at: expect.any(String),
    })
  })

  it("overrides adapter/harness/model/access for a cross-harness handoff and stamps the swap onto handoff", async () => {
    const prev = makePrev()
    const newDesc = { id: "sess_new", harness: "opencode", adapterSlug: "opencode" } as SessionDescriptor
    vi.mocked(spawnAgentSession).mockResolvedValue({
      ok: true,
      descriptor: newDesc,
    })

    const result = await continueAgentSessionFresh(
      { registry: fakeRegistry, resolveAgentAdapter: fakeResolveAdapter },
      prev,
      {
        baseDir: "/tmp/checkpoints",
        harness: "opencode",
        adapter: "opencode",
        model: "gpt-5-nano",
        access: { profileRef: "opencode-wallet" },
      },
    )

    const [, input] = vi.mocked(spawnAgentSession).mock.calls[0]!
    expect(input.adapter).toBe("opencode")
    expect(input.harness).toBe("opencode")
    expect(input.model).toBe("gpt-5-nano")
    expect(input.access).toEqual({ profileRef: "opencode-wallet" })
    // prev's route ({gateway: "anthropic"}) was resolved for the OLD adapter
    // and must NOT ride along into a different one — carrying it forward
    // would also silently skip spawnAgentSession's adapter-capability guard
    // (it only runs when route.gateway is undefined).
    expect(input.route).toBeUndefined()
    // The prompt (checkpoint handoff text) is unaffected by the axis overrides.
    expect(input.prompt).toContain("[continued session")

    expect(result.descriptor.handoff).toEqual({
      fromHarness: "claude-code",
      toHarness: "opencode",
      at: expect.any(String),
    })
  })

  it("leaves adapter/harness/model/access unset when no override is passed (same-harness default)", async () => {
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

    const [, input] = vi.mocked(spawnAgentSession).mock.calls[0]!
    expect(input.adapter).toBe("claude-code")
    expect(input.harness).toBe("claude-code")
    expect(input.model).toBe("claude-sonnet-5")
    expect(input.access).toEqual({ profileRef: "anthropic-main" })
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

  it("continues a source at most once: a sequential duplicate gets the first result and does not spawn again", async () => {
    const prev = makePrev()
    vi.mocked(spawnAgentSession).mockResolvedValue({
      ok: true,
      descriptor: { id: "sess_new" } as SessionDescriptor,
    })
    const deps = { registry: fakeRegistry, resolveAgentAdapter: fakeResolveAdapter }

    const first = await continueAgentSessionFresh(deps, prev, { baseDir: "/tmp/checkpoints" })
    const second = await continueAgentSessionFresh(deps, prev, { baseDir: "/tmp/checkpoints" })

    expect(spawnAgentSession).toHaveBeenCalledOnce()
    expect(second.descriptor.id).toBe(first.descriptor.id)
    expect(second.checkpoint.checkpointId).toBe(first.checkpoint.checkpointId)
  })

  it("continues a source at most once: concurrent calls share one spawn", async () => {
    const prev = makePrev()
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    vi.mocked(spawnAgentSession).mockImplementation(async () => {
      await gate
      return { ok: true, descriptor: { id: "sess_new" } as SessionDescriptor }
    })
    const deps = { registry: fakeRegistry, resolveAgentAdapter: fakeResolveAdapter }

    const a = continueAgentSessionFresh(deps, prev, { baseDir: "/tmp/checkpoints" })
    const b = continueAgentSessionFresh(deps, prev, { baseDir: "/tmp/checkpoints" })
    release()
    const [ra, rb] = await Promise.all([a, b])

    expect(spawnAgentSession).toHaveBeenCalledOnce()
    expect(rb.descriptor.id).toBe(ra.descriptor.id)
    expect(rb.checkpoint.checkpointId).toBe(ra.checkpoint.checkpointId)
  })

  it("allows a retry after a failed continuation", async () => {
    const prev = makePrev()
    const deps = { registry: fakeRegistry, resolveAgentAdapter: fakeResolveAdapter }
    vi.mocked(spawnAgentSession).mockResolvedValueOnce({
      ok: false,
      code: "agent_spawn_failed",
      message: "adapter died",
    })
    await expect(continueAgentSessionFresh(deps, prev, { baseDir: "/tmp/checkpoints" })).rejects.toThrow(
      "agent_spawn_failed",
    )

    vi.mocked(spawnAgentSession).mockResolvedValueOnce({
      ok: true,
      descriptor: { id: "sess_new" } as SessionDescriptor,
    })
    const retry = await continueAgentSessionFresh(deps, prev, { baseDir: "/tmp/checkpoints" })

    expect(retry.descriptor.id).toBe("sess_new")
    expect(spawnAgentSession).toHaveBeenCalledTimes(2)
  })

  it("refuses a second continuation with different options instead of returning the first successor", async () => {
    const prev = makePrev()
    vi.mocked(spawnAgentSession).mockResolvedValueOnce({
      ok: true,
      descriptor: { id: "sess_codex" } as SessionDescriptor,
    })
    const deps = { registry: fakeRegistry, resolveAgentAdapter: fakeResolveAdapter }

    const first = await continueAgentSessionFresh(deps, prev, { baseDir: "/tmp/checkpoints", harness: "codex" })
    await expect(
      continueAgentSessionFresh(deps, prev, { baseDir: "/tmp/checkpoints", harness: "gemini" }),
    ).rejects.toMatchObject({
      code: "already_continued",
      details: { continuedFrom: prev.id, continuedTo: "sess_codex" },
    })

    expect(spawnAgentSession).toHaveBeenCalledOnce()
    expect(first.descriptor.id).toBe("sess_codex")
  })

  it("continues distinct source ids independently", async () => {
    vi.mocked(spawnAgentSession).mockResolvedValue({
      ok: true,
      descriptor: { id: "sess_new" } as SessionDescriptor,
    })
    const deps = { registry: fakeRegistry, resolveAgentAdapter: fakeResolveAdapter }

    await continueAgentSessionFresh(deps, makePrev(), { baseDir: "/tmp/checkpoints" })
    await continueAgentSessionFresh(deps, makePrev(), { baseDir: "/tmp/checkpoints" })

    expect(spawnAgentSession).toHaveBeenCalledTimes(2)
  })

  it("evicts only the oldest settled entry, never an in-flight continuation", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    let pendingStarted!: () => void
    const started = new Promise<void>(resolve => {
      pendingStarted = resolve
    })
    let spawns = 0
    vi.mocked(spawnAgentSession).mockImplementation(async () => {
      spawns += 1
      if (spawns === CONTINUED_SOURCES_MAX + 1) {
        pendingStarted()
        await gate
      }
      return { ok: true, descriptor: { id: `sess_new_${spawns}` } as SessionDescriptor }
    })
    const deps = { registry: fakeRegistry, resolveAgentAdapter: fakeResolveAdapter }

    const sources: SessionDescriptor[] = []
    for (let i = 0; i < CONTINUED_SOURCES_MAX; i += 1) {
      const prev = makePrev()
      sources.push(prev)
      await continueAgentSessionFresh(deps, prev, { baseDir: "/tmp/checkpoints" })
    }
    expect(spawns).toBe(CONTINUED_SOURCES_MAX)

    const pendingPrev = makePrev()
    const a = continueAgentSessionFresh(deps, pendingPrev, { baseDir: "/tmp/checkpoints" })
    const b = continueAgentSessionFresh(deps, pendingPrev, { baseDir: "/tmp/checkpoints" })
    await started
    expect(spawns).toBe(CONTINUED_SOURCES_MAX + 1)
    release()
    const [ra, rb] = await Promise.all([a, b])
    expect(rb.descriptor.id).toBe(ra.descriptor.id)
    expect(spawns).toBe(CONTINUED_SOURCES_MAX + 1)

    // The in-flight continuation displaced the oldest SETTLED entry.
    const oldest = sources[0]!
    await continueAgentSessionFresh(deps, oldest, { baseDir: "/tmp/checkpoints" })
    expect(spawns).toBe(CONTINUED_SOURCES_MAX + 2)

    // The newest settled entry is still memoised.
    const newest = sources[CONTINUED_SOURCES_MAX - 1]!
    await continueAgentSessionFresh(deps, newest, { baseDir: "/tmp/checkpoints" })
    expect(spawns).toBe(CONTINUED_SOURCES_MAX + 2)
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
