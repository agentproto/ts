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
import { createCronScheduler, type CronTurnObservation, type CronTurnObserver } from "../cron-scheduler.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"

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

  it("updates and pauses a job without changing it after invalid input", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const scheduler = createCronScheduler({ ...makeDeps(workspace), workspace })
    try {
      const job = await scheduler.create({ schedule: "* * * * *", action: { kind: "command", command: "echo" } })
      const paused = await scheduler.update(job.id, { active: false, label: "paused", schedule: "0 9 * * *" })
      expect(paused).toMatchObject({ active: false, finished: false, label: "paused", schedule: "0 9 * * *" })
      expect(paused.nextRunAt).toBeUndefined()
      await expect(scheduler.update(job.id, { schedule: "invalid schedule" })).rejects.toThrow()
      expect(scheduler.get(job.id)?.schedule).toBe("0 9 * * *")
      const resumed = await scheduler.update(job.id, { active: true, action: { kind: "command", command: "pwd" } })
      expect(resumed.active).toBe(true)
      expect(resumed.nextRunAt).toBeTruthy()
      expect(resumed.action).toEqual({ kind: "command", command: "pwd" })
    } finally {
      scheduler.shutdown()
    }
  })

  it("persists a bounded run ledger with cursor pagination and a structured spawn id", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const persistPath = join(workspace, "cron-jobs.json")
    const deps = makeDeps(workspace)
    const dispatchTool = vi.fn(async () => ({ content: [{ type: "text", text: JSON.stringify({ id: "spawned-123" }) }] }))
    const scheduler = createCronScheduler({ ...deps, workspace, persistPath, dispatchTool })
    let jobId: string
    try {
      const job = await scheduler.create({ schedule: "* * * * *", action: { kind: "agent", prompt: "hello" } })
      jobId = job.id
      for (let i = 0; i < 52; i++) await scheduler.run(job.id)
      const first = scheduler.runs({ jobId, limit: 20 })
      expect(first.runs).toHaveLength(20)
      expect(first.runs[0]).toMatchObject({ jobId, ok: true, sessionId: "spawned-123" })
      expect(first.runs[0]?.runId).toMatch(/^run_/)
      expect(first.runs[0]?.startedAt).toBeTruthy()
      expect(first.runs[0]?.endedAt).toBeTruthy()
      const second = scheduler.runs({ jobId, limit: 20, cursor: first.nextCursor })
      const third = scheduler.runs({ jobId, limit: 20, cursor: second.nextCursor })
      expect([...first.runs, ...second.runs, ...third.runs]).toHaveLength(50)
      expect(third.nextCursor).toBeUndefined()
      expect(() => scheduler.runs({ jobId, cursor: "missing" })).toThrow(/cursor/)
    } finally {
      scheduler.shutdown()
    }
    const reloaded = createCronScheduler({ ...deps, workspace, persistPath, dispatchTool })
    try {
      expect(reloaded.runs({ jobId: jobId!, limit: 100 }).runs).toHaveLength(50)
    } finally {
      reloaded.shutdown()
    }
  })

  it("create() — valid schedule returns a job with nextRunAt", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const { sessionEvents, registry } = makeDeps(workspace)
    const scheduler = createCronScheduler({ sessionEvents, registry, workspace })
    try {
      const job = await scheduler.create({
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

  it("create() — invalid schedule throws SyntaxError", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const { sessionEvents, registry } = makeDeps(workspace)
    const scheduler = createCronScheduler({ sessionEvents, registry, workspace })
    try {
      await expect(
        scheduler.create({
          schedule: "not a valid cron expression at all !!!",
          recurring: true,
          action: { kind: "command", command: "echo" },
        }),
      ).rejects.toThrow()
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
      const job = await scheduler.create({
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
      const job = await scheduler.create({
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
      const job = await scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: false, // one-shot
        action: { kind: "command", command: "echo", args: ["ping"] },
      })
      expect(job.active).toBe(true)
      await scheduler.run(job.id)
      const after = scheduler.get(job.id)!
      expect(after.active).toBe(false)
      expect(after.finished).toBe(true)
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
      const job = await scheduler.create({
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

  it("delete() — removes job; delete unknown id throws", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const { sessionEvents, registry } = makeDeps(workspace)
    const scheduler = createCronScheduler({ sessionEvents, registry, workspace })
    try {
      const job = await scheduler.create({
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

    const job = await s1.create({
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
      const job = await scheduler.create({
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

  it("run() — agent action lowers to an agent_start call carrying mode, permissionHold, and options", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const { registry } = makeMockRegistry({ processAlive: true })
    const sessionEvents = createSessionEventBus()
    const dispatchTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ id: "sess_bypass" }) }],
    })
    const scheduler = createCronScheduler({ sessionEvents, registry, dispatchTool, workspace })
    try {
      const job = await scheduler.create({
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

      expect(result).toEqual({ ok: true, summary: "spawned session sess_bypass (adapter=mock)" })
      expect(dispatchTool).toHaveBeenCalledOnce()
      expect(dispatchTool).toHaveBeenCalledWith("agent_start", {
        adapter: "mock",
        prompt: "wake up",
        mode: "bypass-permissions",
        permissionHold: true,
        options: { skills: "fast", verbose: true },
        cwd: workspace,
        origin: `cron:${job.id}`,
      })
    } finally {
      scheduler.shutdown()
    }
  })

  it("run() — agent action adds no optional agent_start fields that weren't set", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const { registry } = makeMockRegistry({ processAlive: true })
    const sessionEvents = createSessionEventBus()
    const dispatchTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ id: "sess_plain" }) }],
    })
    const scheduler = createCronScheduler({ sessionEvents, registry, dispatchTool, workspace })
    try {
      const job = await scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: { kind: "agent", adapter: "mock", prompt: "wake up", cwd: "/elsewhere", origin: "nightly" },
      })

      await scheduler.run(job.id)

      // Explicit cwd/origin win over the cron defaults; nothing else is added.
      expect(dispatchTool.mock.calls[0]).toEqual([
        "agent_start",
        { adapter: "mock", prompt: "wake up", cwd: "/elsewhere", origin: "nightly" },
      ])
    } finally {
      scheduler.shutdown()
    }
  })

  it("run() — agent action fails clearly when dispatchTool is not wired", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const { registry } = makeMockRegistry({ processAlive: true })
    const scheduler = createCronScheduler({ sessionEvents: createSessionEventBus(), registry, workspace })
    try {
      const job = await scheduler.create({
        schedule: "0 0 1 1 *",
        action: { kind: "agent", adapter: "mock", prompt: "x" },
      })
      const result = await scheduler.run(job.id)
      expect(result?.ok).toBe(false)
      expect(result?.summary).toMatch(/agent action requires dispatchTool/)
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
    const dispatchTool = vi.fn(
      () => new Promise<unknown>(resolve => { finishStart = () => resolve({ content: [] }) }),
    )
    const scheduler = createCronScheduler({ sessionEvents, registry, dispatchTool, workspace })
    try {
      const job = await scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: { kind: "agent", adapter: "mock", prompt: "slow maintenance" },
      })
      // Make the job due now. The first tick starts it; the second tick lands
      // before agent_start resolves and must observe the in-flight lease.
      job.nextRunAt = new Date(Date.now() - 1).toISOString()

      await vi.advanceTimersByTimeAsync(20_000)
      await Promise.resolve()
      expect(dispatchTool).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(20_000)
      await Promise.resolve()
      expect(dispatchTool).toHaveBeenCalledOnce()

      finishStart?.()
      // Let fireJob finish without draining the scheduler's recurring interval.
      await Promise.resolve()
      await Promise.resolve()
    } finally {
      scheduler.shutdown()
      vi.useRealTimers()
    }
  })

  it("create() — accepts a prompt-session action shape", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const { registry } = makeMockRegistry({ processAlive: true })
    const sessionEvents = createSessionEventBus()
    const scheduler = createCronScheduler({ sessionEvents, registry, workspace })
    try {
      const job = await scheduler.create({
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
      const job = await scheduler.create({
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
      const job = await scheduler.create({
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
      const job = await scheduler.create({
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
      const job = await scheduler.create({
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
      // `restartAgentSession` closes a still-alive prior row after a
      // successful restart (session-restart-core.ts) — a no-op here since
      // `deadDesc.processAlive` is already false, but the call itself still
      // needs a stub on this minimal mock.
      kill: vi.fn(),
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
      const job = await scheduler.create({
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
      kill: vi.fn(),
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
      const job = await scheduler.create({
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
})

// ── create-time adapter check ──────────────────────────────────────

describe("CronScheduler — create-time adapter check", () => {
  let tmpDirs: string[] = []

  afterEach(() => {
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true }) } catch { /* ignore */ }
    }
    tmpDirs = []
  })

  /** Only `claude-code` resolves; `claude-subs-agentik` is an auth profile id. */
  function makeScheduler(extra: Partial<Parameters<typeof createCronScheduler>[0]> = {}) {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const { sessionEvents, registry } = makeDeps(workspace)
    const resolveAgentAdapter = vi.fn(async (slug: string) =>
      slug === "claude-code" ? ({ startSession: vi.fn() } as never) : null,
    )
    const scheduler = createCronScheduler({
      sessionEvents,
      registry,
      workspace,
      resolveAgentAdapter,
      getAuthProfile: async id => (id === "claude-subs-agentik" ? { endpoint: "anthropic" } : undefined),
      listAgentAdapters: async () => [{ slug: "codex" }, { slug: "claude-code" }] as never,
      ...extra,
    })
    return { scheduler, resolveAgentAdapter, workspace }
  }

  it("refuses an agent action whose adapter does not resolve, listing installed adapters", async () => {
    const { scheduler } = makeScheduler()
    try {
      await expect(
        scheduler.create({
          schedule: "0 9 * * *",
          action: { kind: "agent", adapter: "no-such-adapter", prompt: "x" },
        }),
      ).rejects.toThrow(
        "cron action adapter 'no-such-adapter' could not be resolved — refusing to create a job " +
          "that would fail at fire time. Installed adapters: claude-code, codex.",
      )
      expect(scheduler.list()).toEqual([])
    } finally {
      scheduler.shutdown()
    }
  })

  it("refuses an unresolvable `harness` alias the same way", async () => {
    const { scheduler } = makeScheduler()
    try {
      await expect(
        scheduler.create({ schedule: "0 9 * * *", action: { kind: "agent", harness: "nope", prompt: "x" } }),
      ).rejects.toThrow(/adapter 'nope' could not be resolved/)
    } finally {
      scheduler.shutdown()
    }
  })

  it("hints when the slug is an auth profile id, not an adapter", async () => {
    const { scheduler } = makeScheduler()
    try {
      await expect(
        scheduler.create({
          schedule: "50 20 * * *",
          action: { kind: "agent", adapter: "claude-subs-agentik", prompt: "x" },
        }),
      ).rejects.toThrow(
        "'claude-subs-agentik' is an auth profile (endpoint 'anthropic'), not an adapter; " +
          "use adapter: 'claude-code' (or the adapter that bills that endpoint) with " +
          "access.profileRef: 'claude-subs-agentik' (or presetId).",
      )
      expect(scheduler.list()).toEqual([])
    } finally {
      scheduler.shutdown()
    }
  })

  it("also checks a kind:\"tool\" → agent_start action (what routine target.agent lowers to)", async () => {
    const { scheduler } = makeScheduler()
    try {
      await expect(
        scheduler.create({
          schedule: "0 9 * * *",
          action: { kind: "tool", tool: "agent_start", inputs: { adapter: "claude-subs-agentik", prompt: "x" } },
        }),
      ).rejects.toThrow(/is an auth profile/)
    } finally {
      scheduler.shutdown()
    }
  })

  it("accepts a resolvable adapter", async () => {
    const { scheduler, resolveAgentAdapter } = makeScheduler()
    try {
      const job = await scheduler.create({
        schedule: "0 9 * * *",
        action: { kind: "agent", adapter: "claude-code", access: { profileRef: "claude-subs-agentik" }, prompt: "x" },
      })
      expect(job.id).toMatch(/^cron_/)
      expect(resolveAgentAdapter).toHaveBeenCalledWith("claude-code")
    } finally {
      scheduler.shutdown()
    }
  })

  it("skips the check for a sandboxed spawn (the box resolves its own adapter)", async () => {
    const { scheduler, resolveAgentAdapter } = makeScheduler()
    try {
      const job = await scheduler.create({
        schedule: "0 9 * * *",
        action: { kind: "agent", adapter: "box-only-adapter", sandbox: { provider: "docker" }, prompt: "x" } as never,
      })
      expect(job.id).toMatch(/^cron_/)
      expect(resolveAgentAdapter).not.toHaveBeenCalled()
    } finally {
      scheduler.shutdown()
    }
  })

  it("accepts a preset-only agent action (no explicit adapter to check)", async () => {
    const { scheduler, resolveAgentAdapter } = makeScheduler()
    try {
      const job = await scheduler.create({
        schedule: "0 9 * * *",
        action: { kind: "agent", presetId: "cc-subs-agentik", prompt: "x" },
      })
      expect(job.id).toMatch(/^cron_/)
      expect(resolveAgentAdapter).not.toHaveBeenCalled()
    } finally {
      scheduler.shutdown()
    }
  })

  it("boot rehydration keeps loading a persisted job with an unresolvable adapter", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const persistPath = join(workspace, "cron-jobs.json")
    const { writeFileSync } = await import("node:fs")
    writeFileSync(
      persistPath,
      JSON.stringify([
        {
          id: "cron_legacy",
          schedule: "50 20 * * *",
          recurring: true,
          active: true,
          createdAt: new Date().toISOString(),
          action: { kind: "agent", adapter: "claude-subs-agentik", prompt: "x" },
        },
      ]),
    )
    const { scheduler, resolveAgentAdapter } = makeScheduler({ persistPath, persist: true })
    try {
      const job = scheduler.get("cron_legacy")
      expect(job?.active).toBe(true)
      expect(job?.nextRunAt).toBeTruthy()
      expect(resolveAgentAdapter).not.toHaveBeenCalled()
    } finally {
      scheduler.shutdown()
    }
  })
})

// ── run health: real outcome + auto-pause ───────────────────────────

describe("CronScheduler — run health", () => {
  let tmpDirs: string[] = []

  afterEach(() => {
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true }) } catch { /* ignore */ }
    }
    tmpDirs = []
  })

  /** Scheduler with an injected turn observer + an agent_start stub that
   *  returns a session id, so the observed path is exercised. */
  function makeAgentScheduler(
    observeTurn: CronTurnObserver,
    extra: Partial<Parameters<typeof createCronScheduler>[0]> = {},
  ) {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const sessionEvents = createSessionEventBus()
    const registry = { get: vi.fn(), sendPrompt: vi.fn(), spawnAgent: vi.fn() } as unknown as SessionsRegistry
    const dispatchTool = vi.fn(async () => ({
      content: [{ type: "text", text: JSON.stringify({ id: "sess_obs" }) }],
    }))
    const scheduler = createCronScheduler({
      sessionEvents,
      registry,
      dispatchTool,
      workspace,
      observeTurn,
      ...extra,
    })
    return { scheduler, sessionEvents, dispatchTool, workspace }
  }

  const staticObserver = (obs: CronTurnObservation): CronTurnObserver => vi.fn(async () => obs)

  it("records the real outcome, output tokens, and duration of an observed agent run", async () => {
    const { scheduler, dispatchTool } = makeAgentScheduler(
      staticObserver({ outcome: "produced", tokensOut: 120, durationMs: 4210 }),
    )
    try {
      const job = await scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: { kind: "agent", adapter: "mock", prompt: "work" },
      })
      const result = await scheduler.run(job.id)
      expect(result?.ok).toBe(true)
      expect(dispatchTool).toHaveBeenCalledOnce()

      const runs = scheduler.runs({ jobId: job.id }).runs
      expect(runs).toHaveLength(1)
      expect(runs[0]).toMatchObject({
        outcome: "produced",
        ok: true,
        sessionId: "sess_obs",
        tokensOut: 120,
        durationMs: 4210,
      })
      expect(scheduler.get(job.id)?.lastOutcome).toBe("produced")
    } finally {
      scheduler.shutdown()
    }
  })

  it.each([
    ["empty", { outcome: "empty", tokensOut: 0, durationMs: 12 }],
    ["errored", { outcome: "errored", error: "boom" }],
    ["timeout", { outcome: "timeout", durationMs: 30_000 }],
  ] as Array<[string, CronTurnObservation]>)(
    "classifies a %s run as non-productive",
    async (expected, obs) => {
      const { scheduler } = makeAgentScheduler(staticObserver(obs))
      try {
        const job = await scheduler.create({
          schedule: "0 0 1 1 *",
          recurring: true,
          action: { kind: "agent", adapter: "mock", prompt: "work" },
        })
        await scheduler.run(job.id)
        const run = scheduler.runs({ jobId: job.id }).runs[0]!
        expect(run.outcome).toBe(expected)
        expect(run.ok).toBe(false)
        expect(scheduler.get(job.id)?.consecutiveFailures).toBe(1)
      } finally {
        scheduler.shutdown()
      }
    },
  )

  it("counts a failed command as non-productive (no observer involved)", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const { mkdirSync, writeFileSync } = await import("node:fs")
    mkdirSync(join(workspace, ".agentproto"), { recursive: true })
    writeFileSync(
      join(workspace, ".agentproto", "allowed-commands.json"),
      JSON.stringify({ version: 1, commands: [] }),
    )
    const { sessionEvents, registry } = makeDeps(workspace)
    const scheduler = createCronScheduler({ sessionEvents, registry, workspace })
    try {
      const job = await scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: { kind: "command", command: "uname" },
      })
      await scheduler.run(job.id)
      const run = scheduler.runs({ jobId: job.id }).runs[0]!
      expect(run.outcome).toBe("errored")
      expect(scheduler.get(job.id)?.consecutiveFailures).toBe(1)
    } finally {
      scheduler.shutdown()
    }
  })

  it("pauses the job after N consecutive non-productive runs and emits cron:unhealthy", async () => {
    const { scheduler, sessionEvents } = makeAgentScheduler(staticObserver({ outcome: "errored", error: "boom" }))
    const unhealthy: Array<{ jobId: string; consecutiveFailures: number; lastOutcome: string }> = []
    sessionEvents.on("cron:unhealthy", ev =>
      unhealthy.push({ jobId: ev.jobId, consecutiveFailures: ev.consecutiveFailures, lastOutcome: ev.lastOutcome }),
    )
    try {
      const job = await scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: { kind: "agent", adapter: "mock", prompt: "work" },
      })
      await scheduler.run(job.id)
      expect(scheduler.get(job.id)?.active).toBe(true)
      expect(scheduler.get(job.id)?.consecutiveFailures).toBe(1)
      expect(unhealthy).toHaveLength(0)

      await scheduler.run(job.id)
      const after = scheduler.get(job.id)!
      expect(after.active).toBe(false)
      expect(after.consecutiveFailures).toBe(2)
      expect(after.pausedReason).toMatch(/auto-paused after 2 consecutive non-productive runs/)
      expect(unhealthy).toEqual([{ jobId: job.id, consecutiveFailures: 2, lastOutcome: "errored" }])
    } finally {
      scheduler.shutdown()
    }
  })

  it("honours a per-job maxConsecutiveFailures", async () => {
    const { scheduler } = makeAgentScheduler(staticObserver({ outcome: "empty", tokensOut: 0 }))
    try {
      const job = await scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: { kind: "agent", adapter: "mock", prompt: "work" },
        maxConsecutiveFailures: 3,
      })
      await scheduler.run(job.id)
      await scheduler.run(job.id)
      expect(scheduler.get(job.id)?.active).toBe(true)
      await scheduler.run(job.id)
      expect(scheduler.get(job.id)?.active).toBe(false)
      expect(scheduler.get(job.id)?.consecutiveFailures).toBe(3)
    } finally {
      scheduler.shutdown()
    }
  })

  it("resets the failure counter on a produced run", async () => {
    let call = 0
    const observeTurn = vi.fn(async () =>
      call++ === 0
        ? ({ outcome: "errored", error: "boom" } as CronTurnObservation)
        : ({ outcome: "produced", tokensOut: 5 } as CronTurnObservation),
    )
    const { scheduler } = makeAgentScheduler(observeTurn)
    try {
      const job = await scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: { kind: "agent", adapter: "mock", prompt: "work" },
      })
      await scheduler.run(job.id)
      expect(scheduler.get(job.id)?.consecutiveFailures).toBe(1)
      await scheduler.run(job.id)
      expect(scheduler.get(job.id)?.consecutiveFailures).toBe(0)
      expect(scheduler.get(job.id)?.lastOutcome).toBe("produced")
      expect(scheduler.get(job.id)?.active).toBe(true)
    } finally {
      scheduler.shutdown()
    }
  })

  it("clears the pause reason and counter on an explicit resume", async () => {
    const { scheduler } = makeAgentScheduler(staticObserver({ outcome: "timeout" }))
    try {
      const job = await scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: { kind: "agent", adapter: "mock", prompt: "work" },
      })
      await scheduler.run(job.id)
      await scheduler.run(job.id)
      expect(scheduler.get(job.id)?.active).toBe(false)
      const resumed = await scheduler.update(job.id, { active: true })
      expect(resumed.active).toBe(true)
      expect(resumed.pausedReason).toBeUndefined()
      expect(resumed.consecutiveFailures).toBe(0)
    } finally {
      scheduler.shutdown()
    }
  })

  it("does not re-fire a job while its previous run is still being observed", async () => {
    let resolveObs: ((obs: CronTurnObservation) => void) | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const observeTurn: CronTurnObserver = vi.fn(
      () =>
        new Promise<CronTurnObservation>(resolve => {
          resolveObs = resolve
          markStarted?.()
        }),
    )
    const { scheduler, dispatchTool } = makeAgentScheduler(observeTurn)
    try {
      const job = await scheduler.create({
        schedule: "0 0 1 1 *",
        recurring: true,
        action: { kind: "agent", adapter: "mock", prompt: "work" },
      })
      const first = scheduler.run(job.id)
      await started
      // A second fire while the first is still observed must be a no-op.
      await scheduler.run(job.id)
      expect(dispatchTool).toHaveBeenCalledOnce()

      resolveObs!({ outcome: "produced", tokensOut: 1, durationMs: 1 })
      await first
      expect(scheduler.runs({ jobId: job.id }).runs).toHaveLength(1)
    } finally {
      scheduler.shutdown()
    }
  })

  it("ledger stays backward-compatible: a pre-outcome entry still parses", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const persistPath = join(workspace, "cron-jobs.json")
    const { sessionEvents, registry } = makeDeps(workspace)
    const first = createCronScheduler({ sessionEvents, registry, workspace, persistPath, persist: true })
    const job = await first.create({
      schedule: "0 0 1 1 *",
      recurring: true,
      action: { kind: "command", command: "echo" },
    })
    first.shutdown()

    const { writeFileSync } = await import("node:fs")
    writeFileSync(
      `${persistPath}.runs.json`,
      JSON.stringify({
        [job.id]: [
          {
            runId: "run_legacy",
            jobId: job.id,
            startedAt: "2026-01-01T00:00:00.000Z",
            endedAt: "2026-01-01T00:00:01.000Z",
            ok: true,
            result: "legacy entry without an outcome",
          },
        ],
      }),
    )

    const second = createCronScheduler({ sessionEvents, registry, workspace, persistPath, persist: true })
    try {
      const runs = second.runs({ jobId: job.id }).runs
      expect(runs).toHaveLength(1)
      expect(runs[0]).toMatchObject({ runId: "run_legacy", ok: true, result: "legacy entry without an outcome" })
      expect(runs[0]?.outcome).toBeUndefined()
      // A job persisted before health fields existed still reads as healthy.
      expect(second.get(job.id)?.consecutiveFailures).toBeUndefined()
    } finally {
      second.shutdown()
    }
  })
})
