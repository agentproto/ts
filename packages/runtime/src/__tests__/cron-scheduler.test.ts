/**
 * Unit tests for cron-scheduler.ts.
 *
 * Covers:
 *   - create() validates schedule / rejects bad expression
 *   - run() records lastResult
 *   - one-shot deactivation after run()
 *   - delete() including unknown-id error
 *   - persistence round-trip (load → mutate → save → reload)
 *   - allowlist rejection for command jobs
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { join } from "node:path"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { createCronScheduler } from "../cron-scheduler.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createSessionsRegistry, SESSION_ID_ENV, WORKSPACE_SLUG_ENV, type SessionsRegistry } from "../sessions.js"

// ── helpers ────────────────────────────────────────────────────────

function makeDeps(workspace: string) {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persistPath: join(workspace, "sessions.json") })
  return { sessionEvents, registry }
}

function makeTmpWorkspace() {
  return mkdtempSync(join(tmpdir(), "cron-test-"))
}

/** Poll a fire-and-forget read until it resolves non-null, instead of a
 *  fixed sleep-then-read — a single 20ms sleep flakes under CI load
 *  (the write genuinely hasn't landed yet), this doesn't. */
async function pollUntil<T>(read: () => Promise<T | null>, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== null) return value
    if (Date.now() >= deadline) throw new Error("pollUntil timed out")
    await new Promise(res => setTimeout(res, 5))
  }
}

// ── tests ──────────────────────────────────────────────────────────

describe("CronScheduler", () => {
  let tmpDirs: string[] = []

  afterEach(() => {
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true }) } catch { /* ignore */ }
    }
    tmpDirs = []
  })

  it("create() — valid schedule returns a job with nextRunAt", () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const { sessionEvents, registry } = makeDeps(workspace)
    const scheduler = createCronScheduler({ sessionEvents, registry, workspace })
    try {
      const job = scheduler.create({
        schedule: "* * * * *",
        recurring: true,
        action: { kind: "command", command: "echo", args: ["hi"] },
      })
      expect(job.id).toMatch(/^cron_/)
      expect(job.active).toBe(true)
      expect(job.recurring).toBe(true)
      expect(job.nextRunAt).toBeTruthy()
      // nextRunAt should be in the future
      expect(new Date(job.nextRunAt!).getTime()).toBeGreaterThan(Date.now() - 1000)
    } finally {
      scheduler.shutdown()
    }
  })

  it("create() — invalid schedule throws SyntaxError", () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const { sessionEvents, registry } = makeDeps(workspace)
    const scheduler = createCronScheduler({ sessionEvents, registry, workspace })
    try {
      expect(() =>
        scheduler.create({
          schedule: "not a valid cron expression at all !!!",
          recurring: true,
          action: { kind: "command", command: "echo" },
        }),
      ).toThrow()
    } finally {
      scheduler.shutdown()
    }
  })

  it("run() — allowlisted command records ok:true lastResult", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    // Write allowlist
    const { mkdirSync, writeFileSync } = await import("node:fs")
    mkdirSync(join(workspace, ".agentproto"), { recursive: true })
    writeFileSync(
      join(workspace, ".agentproto", "allowed-commands.json"),
      JSON.stringify({ version: 1, commands: ["echo"] }),
    )
    const { sessionEvents, registry } = makeDeps(workspace)
    const scheduler = createCronScheduler({ sessionEvents, registry, workspace })
    try {
      const job = scheduler.create({
        schedule: "0 0 1 1 *", // far future — won't auto-fire
        recurring: true,
        action: { kind: "command", command: "echo", args: ["hello"] },
      })
      const result = await scheduler.run(job.id)
      expect(result).toBeDefined()
      expect(result!.ok).toBe(true)
      expect(result!.summary).toContain("hello")
    } finally {
      scheduler.shutdown()
    }
  })

  it("run() — allowlisted command mints a kind:\"command\" session with the full result", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const { mkdirSync, writeFileSync } = await import("node:fs")
    mkdirSync(join(workspace, ".agentproto"), { recursive: true })
    writeFileSync(
      join(workspace, ".agentproto", "allowed-commands.json"),
      JSON.stringify({ version: 1, commands: ["echo"] }),
    )
    const { sessionEvents, registry } = makeDeps(workspace)
    const scheduler = createCronScheduler({ sessionEvents, registry, workspace })
    try {
      const job = scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: { kind: "command", command: "echo", args: ["from-cron"] },
      })
      await scheduler.run(job.id)

      const commandSessions = registry.list().filter(d => d.kind === "command")
      expect(commandSessions).toHaveLength(1)
      const desc = commandSessions[0]!
      expect(desc.status).toBe("exited")
      expect(desc.label).toBe(`cron:${job.id}`)
      expect(desc.origin).toBe("cron")

      const entry = await pollUntil(() => registry.readCommandLog(desc.id))
      expect(entry).toMatchObject({ command: "echo", args: ["from-cron"], exitCode: 0 })
    } finally {
      scheduler.shutdown()
    }
  })

  it("run() — one-shot job deactivates after firing", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const { mkdirSync, writeFileSync } = await import("node:fs")
    mkdirSync(join(workspace, ".agentproto"), { recursive: true })
    writeFileSync(
      join(workspace, ".agentproto", "allowed-commands.json"),
      JSON.stringify({ version: 1, commands: ["echo"] }),
    )
    const { sessionEvents, registry } = makeDeps(workspace)
    const scheduler = createCronScheduler({ sessionEvents, registry, workspace })
    try {
      const job = scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: false, // one-shot
        action: { kind: "command", command: "echo", args: ["ping"] },
      })
      expect(job.active).toBe(true)
      await scheduler.run(job.id)
      const after = scheduler.get(job.id)!
      expect(after.active).toBe(false)
      expect(after.nextRunAt).toBeUndefined()
    } finally {
      scheduler.shutdown()
    }
  })

  it("run() — non-allowlisted command records ok:false lastResult", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    // Empty allowlist (deny all)
    const { mkdirSync, writeFileSync } = await import("node:fs")
    mkdirSync(join(workspace, ".agentproto"), { recursive: true })
    writeFileSync(
      join(workspace, ".agentproto", "allowed-commands.json"),
      JSON.stringify({ version: 1, commands: [] }),
    )
    const { sessionEvents, registry } = makeDeps(workspace)
    const scheduler = createCronScheduler({ sessionEvents, registry, workspace })
    try {
      const job = scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: { kind: "command", command: "uname", args: ["-a"] },
      })
      const result = await scheduler.run(job.id)
      expect(result).toBeDefined()
      expect(result!.ok).toBe(false)
      expect(result!.summary).toMatch(/not in the allowlist/)
    } finally {
      scheduler.shutdown()
    }
  })

  it("delete() — removes job; delete unknown id throws", () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const { sessionEvents, registry } = makeDeps(workspace)
    const scheduler = createCronScheduler({ sessionEvents, registry, workspace })
    try {
      const job = scheduler.create({
        schedule: "* * * * *",
        recurring: true,
        action: { kind: "command", command: "echo" },
      })
      expect(scheduler.get(job.id)).toBeDefined()
      scheduler.delete(job.id)
      expect(scheduler.get(job.id)).toBeUndefined()
      expect(scheduler.list()).toHaveLength(0)
      expect(() => scheduler.delete(job.id)).toThrow(/not found/)
    } finally {
      scheduler.shutdown()
    }
  })

  it("persistence round-trip — jobs survive save→reload", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const { mkdirSync, writeFileSync } = await import("node:fs")
    mkdirSync(join(workspace, ".agentproto"), { recursive: true })
    writeFileSync(
      join(workspace, ".agentproto", "allowed-commands.json"),
      JSON.stringify({ version: 1, commands: ["echo"] }),
    )
    const persistPath = join(workspace, "cron-jobs.json")
    const { sessionEvents: ev1, registry: r1 } = makeDeps(workspace)
    const s1 = createCronScheduler({
      sessionEvents: ev1, registry: r1, workspace, persistPath, persist: true,
    })

    const job = s1.create({
      schedule: "0 0 1 1 *",
      label: "persisted-job",
      recurring: true,
      action: { kind: "command", command: "echo", args: ["persist"] },
    })
    await s1.run(job.id) // populate lastResult
    s1.shutdown()

    // Confirm file was written
    const raw = JSON.parse(readFileSync(persistPath, "utf8")) as unknown[]
    expect(raw).toHaveLength(1)

    // Reload in a fresh instance
    const { sessionEvents: ev2, registry: r2 } = makeDeps(workspace)
    const s2 = createCronScheduler({
      sessionEvents: ev2, registry: r2, workspace, persistPath, persist: true,
    })
    try {
      const reloaded = s2.get(job.id)
      expect(reloaded).toBeDefined()
      expect(reloaded!.label).toBe("persisted-job")
      expect(reloaded!.lastResult?.ok).toBe(true)
      expect(reloaded!.active).toBe(true) // recurring stays active
    } finally {
      s2.shutdown()
    }
  })

  it("cron:fired / cron:succeeded events are emitted on run()", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const { mkdirSync, writeFileSync } = await import("node:fs")
    mkdirSync(join(workspace, ".agentproto"), { recursive: true })
    writeFileSync(
      join(workspace, ".agentproto", "allowed-commands.json"),
      JSON.stringify({ version: 1, commands: ["echo"] }),
    )
    const { sessionEvents, registry } = makeDeps(workspace)
    const fired: string[] = []
    const succeeded: string[] = []
    sessionEvents.on("cron:fired",     ev => fired.push(ev.jobId))
    sessionEvents.on("cron:succeeded", ev => succeeded.push(ev.jobId))

    const scheduler = createCronScheduler({ sessionEvents, registry, workspace })
    try {
      const job = scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: { kind: "command", command: "echo", args: ["events"] },
      })
      await scheduler.run(job.id)
      expect(fired).toContain(job.id)
      expect(succeeded).toContain(job.id)
    } finally {
      scheduler.shutdown()
    }
  })

  // ── prompt-session action ──────────────────────────────────────────

  function makeMockRegistry(desc: { processAlive?: boolean; busy?: boolean } | undefined): {
    registry: SessionsRegistry
    sendPrompt: ReturnType<typeof vi.fn>
    spawnAgent: ReturnType<typeof vi.fn>
  } {
    const sendPrompt = vi.fn().mockResolvedValue(undefined)
    const spawnAgent = vi.fn().mockImplementation((input: { mode?: string }) => ({
      id: input.mode ? `sess_${input.mode}` : "sess_cron_agent",
      processAlive: true,
    }))
    const registry = {
      get: vi.fn().mockReturnValue(desc),
      sendPrompt,
      spawnAgent,
    } as unknown as SessionsRegistry
    return { registry, sendPrompt, spawnAgent }
  }

  it("run() — agent action threads mode, permissionHold, and options into startSession and spawnAgent", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const { registry, sendPrompt, spawnAgent } = makeMockRegistry({ processAlive: true })
    const sessionEvents = createSessionEventBus()
    const startSession = vi.fn().mockResolvedValue({ id: "adapter_sess_1" })
    const resolveAgentAdapter = vi.fn().mockResolvedValue({ startSession })
    const scheduler = createCronScheduler({ sessionEvents, registry, resolveAgentAdapter, workspace })
    try {
      const job = scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: {
          kind: "agent",
          adapter: "mock",
          prompt: "wake up",
          mode: "bypass-permissions",
          permissionHold: true,
          options: { skills: "fast", verbose: true },
        },
      })

      const result = await scheduler.run(job.id)

      expect(result).toBeDefined()
      expect(result!.ok).toBe(true)
      expect(startSession).toHaveBeenCalledOnce()
      expect(startSession).toHaveBeenCalledWith({
        cwd: workspace,
        // Persistent isolated-config dir, keyed by the minted session id —
        // what lets a reaped cron session natively resume (see
        // adapterConfigDirFor in sessions.ts).
        configDir: expect.stringContaining("adapter-config"),
        mode: "bypass-permissions",
        permissionHold: true,
        options: { skills: "fast", verbose: true },
        env: {
          [SESSION_ID_ENV]: expect.any(String),
          [WORKSPACE_SLUG_ENV]: "default",
        },
      })
      expect(spawnAgent).toHaveBeenCalledOnce()
      expect(spawnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "bypass-permissions",
        }),
      )
      expect(sendPrompt).toHaveBeenCalledWith("sess_bypass-permissions", "wake up")
    } finally {
      scheduler.shutdown()
    }
  })

  it("run() — agent action omits mode, permissionHold, and options when not provided", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const { registry, spawnAgent } = makeMockRegistry({ processAlive: true })
    const sessionEvents = createSessionEventBus()
    const startSession = vi.fn().mockResolvedValue({ id: "adapter_sess_2" })
    const resolveAgentAdapter = vi.fn().mockResolvedValue({ startSession })
    const scheduler = createCronScheduler({ sessionEvents, registry, resolveAgentAdapter, workspace })
    try {
      const job = scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: {
          kind: "agent",
          adapter: "mock",
          prompt: "wake up",
        },
      })

      await scheduler.run(job.id)

      expect(startSession).toHaveBeenCalledOnce()
      const startArgs = startSession.mock.calls[0]![0]
      expect(startArgs).toMatchObject({ cwd: workspace })
      expect(startArgs).not.toHaveProperty("mode")
      expect(startArgs).not.toHaveProperty("permissionHold")
      expect(startArgs).not.toHaveProperty("options")
      expect(spawnAgent).toHaveBeenCalledOnce()
      const spawnArgs = spawnAgent.mock.calls[0]![0]
      expect(spawnArgs).not.toHaveProperty("mode")
    } finally {
      scheduler.shutdown()
    }
  })

  it("tick() — does not overlap a slow agent action while its scheduled slot is elapsed", async () => {
    vi.useFakeTimers()
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const { registry } = makeMockRegistry({ processAlive: true })
    const sessionEvents = createSessionEventBus()
    let finishStart: (() => void) | undefined
    const startSession = vi.fn(
      () => new Promise<void>(resolve => { finishStart = resolve }),
    )
    const resolveAgentAdapter = vi.fn().mockResolvedValue({ startSession })
    const scheduler = createCronScheduler({ sessionEvents, registry, resolveAgentAdapter, workspace })
    try {
      const job = scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: { kind: "agent", adapter: "mock", prompt: "slow maintenance" },
      })
      // Make the job due now. The first tick starts it; the second tick lands
      // before startSession resolves and must observe the in-flight lease.
      job.nextRunAt = new Date(Date.now() - 1).toISOString()

      await vi.advanceTimersByTimeAsync(20_000)
      await Promise.resolve()
      expect(startSession).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(20_000)
      await Promise.resolve()
      expect(startSession).toHaveBeenCalledOnce()

      finishStart?.()
      // Let fireJob finish without draining the scheduler's recurring interval.
      await Promise.resolve()
      await Promise.resolve()
    } finally {
      scheduler.shutdown()
      vi.useRealTimers()
    }
  })

  it("create() — accepts a prompt-session action shape", () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const { registry } = makeMockRegistry({ processAlive: true })
    const sessionEvents = createSessionEventBus()
    const scheduler = createCronScheduler({ sessionEvents, registry, workspace })
    try {
      const job = scheduler.create({
        schedule: "* * * * *",
        recurring: true,
        action: { kind: "prompt-session", sessionId: "sess_abc", prompt: "status?" },
      })
      expect(job.action).toEqual({
        kind: "prompt-session",
        sessionId: "sess_abc",
        prompt: "status?",
      })
    } finally {
      scheduler.shutdown()
    }
  })

  it("run() — prompt-session action re-prompts a live session via registry.sendPrompt", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const { registry, sendPrompt } = makeMockRegistry({ processAlive: true })
    const sessionEvents = createSessionEventBus()
    const scheduler = createCronScheduler({ sessionEvents, registry, workspace })
    try {
      const job = scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: { kind: "prompt-session", sessionId: "sess_abc", prompt: "status?" },
      })
      const result = await scheduler.run(job.id)
      expect(result).toBeDefined()
      expect(result!.ok).toBe(true)
      expect(result!.summary).toContain("sess_abc")
      expect(sendPrompt).toHaveBeenCalledWith("sess_abc", "status?")
    } finally {
      scheduler.shutdown()
    }
  })

  it("run() — prompt-session action fails cleanly when the session is missing", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const { registry, sendPrompt } = makeMockRegistry(undefined)
    const sessionEvents = createSessionEventBus()
    const scheduler = createCronScheduler({ sessionEvents, registry, workspace })
    try {
      const job = scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: { kind: "prompt-session", sessionId: "sess_missing", prompt: "status?" },
      })
      const result = await scheduler.run(job.id)
      expect(result).toBeDefined()
      expect(result!.ok).toBe(false)
      expect(result!.summary).toMatch(/not found/)
      expect(sendPrompt).not.toHaveBeenCalled()
    } finally {
      scheduler.shutdown()
    }
  })

  it("run() — prompt-session action fails cleanly when the session is dead and no resolveAgentAdapter", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const { registry, sendPrompt } = makeMockRegistry({ processAlive: false })
    const sessionEvents = createSessionEventBus()
    // No resolveAgentAdapter wired — degraded fallback path.
    const scheduler = createCronScheduler({ sessionEvents, registry, workspace })
    try {
      const job = scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: { kind: "prompt-session", sessionId: "sess_dead", prompt: "status?" },
      })
      const result = await scheduler.run(job.id)
      expect(result).toBeDefined()
      expect(result!.ok).toBe(false)
      // The message is "not alive and agent restart is not enabled (no resolveAgentAdapter)"
      expect(result!.summary).toMatch(/not enabled/)
      expect(sendPrompt).not.toHaveBeenCalled()
    } finally {
      scheduler.shutdown()
    }
  })

  it("run() — prompt-session action busy-skips a mid-turn session", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const { registry, sendPrompt } = makeMockRegistry({ processAlive: true, busy: true })
    const sessionEvents = createSessionEventBus()
    const scheduler = createCronScheduler({ sessionEvents, registry, workspace })
    try {
      const job = scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: { kind: "prompt-session", sessionId: "sess_busy", prompt: "status?" },
      })
      const result = await scheduler.run(job.id)
      expect(result).toBeDefined()
      expect(result!.ok).toBe(true)
      expect(result!.summary).toMatch(/busy/)
      // Must NOT re-prompt while the session is mid-turn.
      expect(sendPrompt).not.toHaveBeenCalled()
    } finally {
      scheduler.shutdown()
    }
  })

  it("run() — prompt-session auto-resumes a dead session and self-heals action.sessionId", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const persistPath = join(workspace, "cron-jobs.json")

    // Descriptor for the dead session returned by registry.get().
    const deadDesc = {
      id: "sess_dead",
      processAlive: false,
      adapterSlug: "mock-adapter",
      cwd: workspace,
      workspaceSlug: "default",
    }
    const resumedDesc = {
      id: "sess_resumed",
      processAlive: true,
    }

    const sendPrompt = vi.fn().mockResolvedValue(undefined)
    const spawnAgent = vi.fn().mockReturnValue(resumedDesc)
    const pulseActivity = vi.fn()
    const mockRegistry = {
      get: vi.fn().mockReturnValue(deadDesc),
      sendPrompt,
      spawnAgent,
      pulseActivity,
    } as unknown as SessionsRegistry

    // resolveAgentAdapter returns a minimal adapter that can start a session.
    const mockAgentSession = { id: "adapter_sess_1" }
    const startSession = vi.fn().mockResolvedValue(mockAgentSession)
    const resolveAgentAdapter = vi.fn().mockResolvedValue({ startSession })

    const sessionEvents = createSessionEventBus()
    const { mkdirSync, writeFileSync } = await import("node:fs")
    mkdirSync(join(workspace, ".agentproto"), { recursive: true })
    writeFileSync(
      join(workspace, ".agentproto", "allowed-commands.json"),
      JSON.stringify({ version: 1, commands: [] }),
    )
    const scheduler = createCronScheduler({
      sessionEvents,
      registry: mockRegistry,
      resolveAgentAdapter,
      workspace,
      persistPath,
      persist: true,
    })
    try {
      const job = scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: { kind: "prompt-session", sessionId: "sess_dead", prompt: "wake up!" },
      })

      const result = await scheduler.run(job.id)

      // Auto-resume succeeded.
      expect(result).toBeDefined()
      expect(result!.ok).toBe(true)
      expect(result!.summary).toMatch(/resumed/)

      // The adapter was asked to start a session.
      expect(startSession).toHaveBeenCalledOnce()

      // sendPrompt was called on the NEW session id, not the dead one.
      expect(sendPrompt).toHaveBeenCalledWith("sess_resumed", "wake up!")

      // action.sessionId was self-healed in-place on the job object.
      const updated = scheduler.get(job.id)!
      expect((updated.action as { sessionId: string }).sessionId).toBe("sess_resumed")

      // The mutation must be persisted to disk.
      await new Promise(res => setTimeout(res, 20))
      const { readFileSync } = await import("node:fs")
      const persisted = JSON.parse(readFileSync(persistPath, "utf8")) as Array<{
        action: { sessionId: string }
      }>
      expect(persisted[0]!.action.sessionId).toBe("sess_resumed")
    } finally {
      scheduler.shutdown()
    }
  })

  it("run() — auto-resume reports no continuity when the dead session never captured an adapterSessionId", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)

    // No `adapterSessionId` — simulates a session that died before its
    // first turn, so there was never anything to resume from. The fix
    // in fb652fa is what makes this honestly report "no continuity"
    // instead of falsely claiming a resume happened.
    const deadDesc = {
      id: "sess_dead",
      processAlive: false,
      adapterSlug: "mock-adapter",
      cwd: workspace,
      workspaceSlug: "default",
    }
    const resumedDesc = { id: "sess_resumed", processAlive: true }

    const sendPrompt = vi.fn().mockResolvedValue(undefined)
    const spawnAgent = vi.fn().mockReturnValue(resumedDesc)
    const pulseActivity = vi.fn()
    const mockRegistry = {
      get: vi.fn().mockReturnValue(deadDesc),
      sendPrompt,
      spawnAgent,
      pulseActivity,
    } as unknown as SessionsRegistry

    const mockAgentSession = { id: "adapter_sess_1" }
    const startSession = vi.fn().mockResolvedValue(mockAgentSession)
    const resolveAgentAdapter = vi.fn().mockResolvedValue({ startSession })

    const sessionEvents = createSessionEventBus()
    const scheduler = createCronScheduler({
      sessionEvents,
      registry: mockRegistry,
      resolveAgentAdapter,
      workspace,
    })
    try {
      const job = scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: { kind: "prompt-session", sessionId: "sess_dead", prompt: "wake up!" },
      })
      const result = await scheduler.run(job.id)

      expect(result).toBeDefined()
      expect(result!.ok).toBe(true)
      expect(result!.summary).toMatch(/fresh spawn, no continuity/)

      // Called with no resumeSessionId — there was never one to attempt.
      expect(startSession).toHaveBeenCalledOnce()
      expect(startSession.mock.calls[0]![0]).not.toHaveProperty("resumeSessionId")

      expect(sendPrompt).toHaveBeenCalledWith("sess_resumed", "wake up!")
    } finally {
      scheduler.shutdown()
    }
  })

  it("run() — kind:\"agent\" forwards mode/permissionHold/options into startSession and mode into spawnAgent", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)

    const spawnedDesc = { id: "sess_new", processAlive: true }
    const sendPrompt = vi.fn().mockResolvedValue(undefined)
    const spawnAgent = vi.fn().mockReturnValue(spawnedDesc)
    const mockRegistry = {
      spawnAgent,
      sendPrompt,
    } as unknown as SessionsRegistry

    const mockAgentSession = { id: "adapter_sess_1" }
    const startSession = vi.fn().mockResolvedValue(mockAgentSession)
    const resolveAgentAdapter = vi.fn().mockResolvedValue({ startSession })

    const sessionEvents = createSessionEventBus()
    const scheduler = createCronScheduler({
      sessionEvents,
      registry: mockRegistry,
      resolveAgentAdapter,
      workspace,
    })
    try {
      const job = scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: {
          kind: "agent",
          adapter: "claude-code",
          prompt: "ship it",
          mode: "bypass-permissions",
          permissionHold: true,
          options: { skills: "docs" },
        },
      })
      const result = await scheduler.run(job.id)

      expect(result).toBeDefined()
      expect(result!.ok).toBe(true)

      expect(startSession).toHaveBeenCalledOnce()
      expect(startSession.mock.calls[0]![0]).toMatchObject({
        cwd: workspace,
        mode: "bypass-permissions",
        permissionHold: true,
        options: { skills: "docs" },
      })

      expect(spawnAgent).toHaveBeenCalledOnce()
      expect(spawnAgent.mock.calls[0]![0]).toMatchObject({ mode: "bypass-permissions" })

      expect(sendPrompt).toHaveBeenCalledWith("sess_new", "ship it")
    } finally {
      scheduler.shutdown()
    }
  })

  it("run() — kind:\"agent\" without mode/permissionHold/options leaks none of them into startSession", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)

    const spawnedDesc = { id: "sess_new", processAlive: true }
    const sendPrompt = vi.fn().mockResolvedValue(undefined)
    const spawnAgent = vi.fn().mockReturnValue(spawnedDesc)
    const mockRegistry = {
      spawnAgent,
      sendPrompt,
    } as unknown as SessionsRegistry

    const mockAgentSession = { id: "adapter_sess_1" }
    const startSession = vi.fn().mockResolvedValue(mockAgentSession)
    const resolveAgentAdapter = vi.fn().mockResolvedValue({ startSession })

    const sessionEvents = createSessionEventBus()
    const scheduler = createCronScheduler({
      sessionEvents,
      registry: mockRegistry,
      resolveAgentAdapter,
      workspace,
    })
    try {
      const job = scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: { kind: "agent", adapter: "claude-code", prompt: "ship it" },
      })
      const result = await scheduler.run(job.id)

      expect(result).toBeDefined()
      expect(result!.ok).toBe(true)

      expect(startSession).toHaveBeenCalledOnce()
      const startSessionArg = startSession.mock.calls[0]![0]
      expect(startSessionArg).toEqual({
        cwd: workspace,
        // Always present — the persistent isolated-config dir is not one of
        // the leak-prone optional fields this test guards, it's part of the
        // base spawn contract (see adapterConfigDirFor in sessions.ts).
        configDir: expect.stringContaining("adapter-config"),
        env: {
          [SESSION_ID_ENV]: expect.any(String),
          [WORKSPACE_SLUG_ENV]: "default",
        },
      })
      expect(startSessionArg).not.toHaveProperty("mode")
      expect(startSessionArg).not.toHaveProperty("permissionHold")
      expect(startSessionArg).not.toHaveProperty("options")

      expect(spawnAgent).toHaveBeenCalledOnce()
      expect(spawnAgent.mock.calls[0]![0]).not.toHaveProperty("mode")
    } finally {
      scheduler.shutdown()
    }
  })
})
