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

      await new Promise(res => setTimeout(res, 20)) // fire-and-forget write
      const entry = await registry.readCommandLog(desc.id)
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

  function makeMockRegistry(desc: { processAlive?: boolean } | undefined): {
    registry: SessionsRegistry
    sendPrompt: ReturnType<typeof vi.fn>
  } {
    const sendPrompt = vi.fn().mockResolvedValue(undefined)
    const registry = {
      get: vi.fn().mockReturnValue(desc),
      sendPrompt,
    } as unknown as SessionsRegistry
    return { registry, sendPrompt }
  }

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

  it("run() — prompt-session action fails cleanly when the session is dead", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const { registry, sendPrompt } = makeMockRegistry({ processAlive: false })
    const sessionEvents = createSessionEventBus()
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
      expect(result!.summary).toMatch(/not alive/)
      expect(sendPrompt).not.toHaveBeenCalled()
    } finally {
      scheduler.shutdown()
    }
  })
})
