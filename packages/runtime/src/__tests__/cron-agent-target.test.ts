/**
 * A `prompt-session` cron job can target an AGENT LABEL instead of a
 * session id (`agent:<label>`). The label is resolved at FIRE time, so the
 * job survives the target agent being relaunched under a new id: the label
 * rides along, the id does not.
 *
 * Covers:
 *   - the label resolves to the live session and prompts it (case-insensitive)
 *   - the SAME job reaches the successor's new id after a relaunch
 *   - an ambiguous label picks the most recently started live session
 *   - an unknown label fails the tick, naming the label
 *   - a legacy `sessionId` job is unchanged
 *   - target normalization (`agent:<label>`) and the exactly-one-target rule
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCronScheduler, normalizeCronAction } from "../cron-scheduler.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createSessionsRegistry, type SessionDescriptor, type SessionsRegistry } from "../sessions.js"

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "cron-agent-target-"))
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const scheduler = createCronScheduler({ sessionEvents, registry, workspace: tmp })
  return {
    tmp,
    registry,
    scheduler,
    cleanup: () => {
      scheduler.shutdown()
      registry.shutdown()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

/** A live agent-cli session carrying `label`. */
function spawnLabelled(
  registry: SessionsRegistry,
  label: string,
  startedAt?: string,
): SessionDescriptor {
  const desc = registry.spawnAgent({
    workspaceSlug: "default",
    cwd: "/tmp",
    adapterSlug: "fake",
    label,
    agentSession: {
      sessionId: `acp-${label}-${Math.random().toString(36).slice(2)}`,
      async *send() {},
      async cancel() {},
      async close() {},
    },
  })
  if (startedAt) {
    const row = registry.get(desc.id)
    if (row) row.startedAt = startedAt
  }
  return desc
}

describe("cron prompt-session — agent label target", () => {
  let cleanups: Array<() => void> = []

  afterEach(() => {
    for (const c of cleanups) c()
    cleanups = []
  })

  it("resolves the label to the live session and prompts it", async () => {
    const { registry, scheduler, cleanup } = setup()
    cleanups.push(cleanup)
    const live = spawnLabelled(registry, "pm")
    const spy = vi.spyOn(registry, "sendPrompt").mockResolvedValue(undefined)

    const job = await scheduler.create({
      schedule: "0 0 1 1 *",
      recurring: true,
      action: { kind: "prompt-session", agent: "pm", prompt: "status?" },
    })
    const result = await scheduler.run(job.id)

    expect(result?.ok).toBe(true)
    expect(spy).toHaveBeenCalledWith(live.id, "status?", { source: "cron" })
    // The run says which session the label resolved to.
    expect(result?.summary).toContain(live.id)
    expect(scheduler.runs({ jobId: job.id }).runs[0]?.sessionId).toBe(live.id)
  })

  it("matches the label case-insensitively", async () => {
    const { registry, scheduler, cleanup } = setup()
    cleanups.push(cleanup)
    const live = spawnLabelled(registry, "PM")
    const spy = vi.spyOn(registry, "sendPrompt").mockResolvedValue(undefined)

    const job = await scheduler.create({
      schedule: "0 0 1 1 *",
      action: { kind: "prompt-session", agent: "pm", prompt: "status?" },
    })
    await scheduler.run(job.id)

    expect(spy).toHaveBeenCalledWith(live.id, "status?", { source: "cron" })
  })

  it("the SAME job reaches the successor's new id after the agent is relaunched", async () => {
    const { registry, scheduler, cleanup } = setup()
    cleanups.push(cleanup)
    const spy = vi.spyOn(registry, "sendPrompt").mockResolvedValue(undefined)

    // The job is created while the FIRST session (id A) is the live one.
    const first = spawnLabelled(registry, "pm")
    const job = await scheduler.create({
      schedule: "0 0 1 1 *",
      recurring: true,
      action: { kind: "prompt-session", agent: "pm", prompt: "ping" },
    })
    await scheduler.run(job.id)
    expect(spy).toHaveBeenLastCalledWith(first.id, "ping", { source: "cron" })

    // The agent is relaunched: a new session (id B) carries the same label,
    // and A is retired with B as its successor.
    const second = spawnLabelled(registry, "pm")
    registry.markRetired(first.id, { continuedTo: second.id, cause: "continued" })

    const result = await scheduler.run(job.id)

    expect(result?.ok).toBe(true)
    expect(spy).toHaveBeenLastCalledWith(second.id, "ping", { source: "cron" })
    expect(result?.summary).toContain(second.id)
    // The job's stored target is still the LABEL — not a stale id.
    const stored = scheduler.get(job.id)!.action as { agent?: string; sessionId?: string }
    expect(stored.agent).toBe("pm")
    expect(stored.sessionId).toBeUndefined()
  })

  it("follows a retired session's successor when the successor carries no label", async () => {
    const { registry, scheduler, cleanup } = setup()
    cleanups.push(cleanup)
    const spy = vi.spyOn(registry, "sendPrompt").mockResolvedValue(undefined)

    const first = spawnLabelled(registry, "pm")
    const second = spawnLabelled(registry, "other-label")
    registry.markRetired(first.id, { continuedTo: second.id, cause: "continued" })

    const job = await scheduler.create({
      schedule: "0 0 1 1 *",
      action: { kind: "prompt-session", agent: "pm", prompt: "ping" },
    })
    const result = await scheduler.run(job.id)

    expect(result?.ok).toBe(true)
    expect(spy).toHaveBeenCalledWith(second.id, "ping", { source: "cron" })
    expect(result?.summary).toContain(second.id)
  })

  it("an ambiguous label picks the most recently started live session", async () => {
    const { registry, scheduler, cleanup } = setup()
    cleanups.push(cleanup)
    const spy = vi.spyOn(registry, "sendPrompt").mockResolvedValue(undefined)

    const older = spawnLabelled(registry, "pm", "2026-01-01T00:00:00.000Z")
    const newer = spawnLabelled(registry, "pm", "2026-02-01T00:00:00.000Z")

    const job = await scheduler.create({
      schedule: "0 0 1 1 *",
      action: { kind: "prompt-session", agent: "pm", prompt: "ping" },
    })
    const result = await scheduler.run(job.id)

    expect(result?.ok).toBe(true)
    expect(spy).toHaveBeenCalledWith(newer.id, "ping", { source: "cron" })
    expect(spy).not.toHaveBeenCalledWith(older.id, "ping", { source: "cron" })
    expect(result?.summary).toContain(newer.id)
  })

  it("an unknown label fails the tick, naming the label", async () => {
    const { registry, scheduler, cleanup } = setup()
    cleanups.push(cleanup)
    const spy = vi.spyOn(registry, "sendPrompt").mockResolvedValue(undefined)

    const job = await scheduler.create({
      schedule: "0 0 1 1 *",
      action: { kind: "prompt-session", agent: "nobody", prompt: "ping" },
    })
    const result = await scheduler.run(job.id)

    expect(result?.ok).toBe(false)
    expect(result?.summary).toMatch(/nobody/)
    expect(spy).not.toHaveBeenCalled()
  })

  it("a busy target is skipped like the id path does", async () => {
    const { registry, scheduler, cleanup } = setup()
    cleanups.push(cleanup)
    const live = spawnLabelled(registry, "pm")
    const row = registry.get(live.id)!
    row.busy = true
    const spy = vi.spyOn(registry, "sendPrompt").mockResolvedValue(undefined)

    const job = await scheduler.create({
      schedule: "0 0 1 1 *",
      action: { kind: "prompt-session", agent: "pm", prompt: "ping" },
    })
    const result = await scheduler.run(job.id)

    expect(result?.ok).toBe(true)
    expect(result?.summary).toMatch(/busy/)
    expect(spy).not.toHaveBeenCalled()
  })

  it("revives an ended session with that label through the usual restart path", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "cron-agent-target-restart-"))
    const deadDesc = {
      id: "sess_dead",
      label: "pm",
      status: "exited",
      processAlive: false,
      startedAt: "2026-01-01T00:00:00.000Z",
      adapterSlug: "mock-adapter",
      cwd: workspace,
      workspaceSlug: "default",
    }
    const resumedDesc = {
      id: "sess_resumed",
      label: "pm",
      status: "running",
      processAlive: true,
      startedAt: "2026-02-01T00:00:00.000Z",
    }
    const sendPrompt = vi.fn().mockResolvedValue(undefined)
    const spawnAgent = vi.fn().mockReturnValue(resumedDesc)
    const registry = {
      get: vi.fn((id: string) => (id === "sess_dead" ? deadDesc : resumedDesc)),
      list: vi.fn(() => [deadDesc]),
      sendPrompt,
      spawnAgent,
      pulseActivity: vi.fn(),
      kill: vi.fn(),
    } as unknown as SessionsRegistry
    const startSession = vi.fn().mockResolvedValue({ id: "adapter_sess_1" })
    const resolveAgentAdapter = vi.fn().mockResolvedValue({ startSession })
    const scheduler = createCronScheduler({
      sessionEvents: createSessionEventBus(),
      registry,
      resolveAgentAdapter,
      workspace,
    })
    try {
      const job = await scheduler.create({
        schedule: "0 0 1 1 *",
        action: { kind: "prompt-session", agent: "pm", prompt: "wake up!" },
      })
      const result = await scheduler.run(job.id)

      expect(result?.ok).toBe(true)
      expect(result?.summary).toContain("sess_resumed")
      expect(result?.summary).toContain("resumed as")
      expect(startSession).toHaveBeenCalledOnce()
      expect(sendPrompt).toHaveBeenCalledWith("sess_resumed", "wake up!", { source: "cron" })
      // The job keeps targeting the LABEL, not the revived id.
      const stored = scheduler.get(job.id)!.action as { agent?: string; sessionId?: string }
      expect(stored.agent).toBe("pm")
      expect(stored.sessionId).toBeUndefined()
    } finally {
      scheduler.shutdown()
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it("a legacy sessionId job is unchanged", async () => {
    const { registry, scheduler, cleanup } = setup()
    cleanups.push(cleanup)
    const live = spawnLabelled(registry, "pm")
    const spy = vi.spyOn(registry, "sendPrompt").mockResolvedValue(undefined)

    const job = await scheduler.create({
      schedule: "0 0 1 1 *",
      recurring: true,
      action: { kind: "prompt-session", sessionId: live.id, prompt: "status?" },
    })
    expect(job.action).toEqual({
      kind: "prompt-session",
      sessionId: live.id,
      prompt: "status?",
    })

    const result = await scheduler.run(job.id)
    expect(result?.ok).toBe(true)
    expect(result?.summary).toBe(`re-prompted session ${live.id}`)
    expect(spy).toHaveBeenCalledWith(live.id, "status?", { source: "cron" })
  })
})

describe("cron prompt-session — target normalization", () => {
  it("accepts the agent:<label> spelling and stores it as an agent target", () => {
    expect(normalizeCronAction({ kind: "prompt-session", sessionId: "agent:pm", prompt: "x" })).toEqual({
      kind: "prompt-session",
      agent: "pm",
      prompt: "x",
    })
  })

  it("normalizes a persisted agent:<label> job on boot", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "cron-agent-target-boot-"))
    const persistPath = join(tmp, "cron-jobs.json")
    writeFileSync(
      persistPath,
      JSON.stringify([
        {
          id: "cron_persisted",
          schedule: "0 0 1 1 *",
          recurring: true,
          active: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          action: { kind: "prompt-session", sessionId: "agent:pm", prompt: "ping" },
        },
      ]),
    )
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    const live = spawnLabelled(registry, "pm")
    const spy = vi.spyOn(registry, "sendPrompt").mockResolvedValue(undefined)
    const scheduler = createCronScheduler({
      sessionEvents,
      registry,
      workspace: tmp,
      persistPath,
      persist: true,
    })
    try {
      const job = scheduler.get("cron_persisted")!
      expect(job.action).toEqual({ kind: "prompt-session", agent: "pm", prompt: "ping" })
      const result = await scheduler.run("cron_persisted")
      expect(result?.ok).toBe(true)
      expect(spy).toHaveBeenCalledWith(live.id, "ping", { source: "cron" })
    } finally {
      scheduler.shutdown()
      registry.shutdown()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("refuses two targets and refuses none", () => {
    expect(() =>
      normalizeCronAction({ kind: "prompt-session", sessionId: "sess_a", agent: "pm", prompt: "x" }),
    ).toThrow(/exactly one/)
    expect(() => normalizeCronAction({ kind: "prompt-session", prompt: "x" })).toThrow(/target/)
  })

  it("leaves a plain sessionId action untouched", () => {
    expect(normalizeCronAction({ kind: "prompt-session", sessionId: "sess_a", prompt: "x" })).toEqual({
      kind: "prompt-session",
      sessionId: "sess_a",
      prompt: "x",
    })
  })
})
