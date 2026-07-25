import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSessionsRegistry,
  type AgentSessionLike,
  type SessionDescriptor,
  type RestartPolicy,
} from "../sessions.js"
import {
  isEligibleForRestart,
  computeBackoffMs,
  evaluateRestartDecision,
  createRestartScheduler,
  runRestartSweepPass,
  type RestartSchedulerRegistry,
} from "../restart-scheduler.js"
import { createSessionEventBus, type SessionExitedEvent } from "../session-event-bus.js"

/**
 * Restart scheduler (restart-scheduler PR-2).
 *
 * Layers, tested separately (mirroring crash-reaper.test.ts / idle-reaper.test.ts):
 *   1. `isEligibleForRestart` — the decision gate (which death reasons restart).
 *   2. `computeBackoffMs` / `evaluateRestartDecision` — the backoff curve + the
 *      rolling-window crash-loop cap. Pure over a fake clock.
 *   3. `runRestartSweepPass` — the SWEEP (which due rows get executed). Driven
 *      against a stub registry so candidate selection is deterministic.
 *   4. `createRestartScheduler` — the event-driven half, against a fake bus +
 *      stub registry.
 *   5. End-to-end against a real registry: a crash schedules a restart, the
 *      sweep executes it, and a session that crashes TWICE (resume in
 *      between) is scheduled twice — pinning the `exitedEmitted` reset fix.
 */

const BASE_POLICY: RestartPolicy = {
  on: ["crashed", "error"],
  maxRetries: 3,
  windowMs: 60_000,
  baseDelayMs: 1_000,
  factor: 2,
  maxDelayMs: 30_000,
}

function row(over: Partial<SessionDescriptor> & { id: string }): SessionDescriptor {
  return {
    kind: "agent-cli",
    workspaceSlug: "default",
    command: "claude (agent)",
    pid: null,
    status: "running",
    startedAt: "2026-07-23T00:00:00Z",
    adapterSlug: "claude-code",
    adapterSessionId: `acp-${over.id}`,
    cwd: "/tmp",
    restartPolicy: BASE_POLICY,
    ...over,
  }
}

// ── Layer 1: isEligibleForRestart — the decision gate ──────────────────────

describe("isEligibleForRestart", () => {
  it("restarts a crashed row when the policy opts into \"crashed\"", () => {
    expect(
      isEligibleForRestart(row({ id: "a", status: "error", endedReason: "crashed" })),
    ).toBe(true)
  })

  it("restarts an unexpected turn-error row (status error, no endedReason) when the policy opts into \"error\"", () => {
    expect(isEligibleForRestart(row({ id: "a", status: "error" }))).toBe(true)
  })

  it("does NOT restart without a restartPolicy at all", () => {
    expect(
      isEligibleForRestart(
        row({ id: "a", status: "error", endedReason: "crashed", restartPolicy: undefined }),
      ),
    ).toBe(false)
  })

  it("does NOT restart \"crashed\" when the policy only opts into \"error\"", () => {
    expect(
      isEligibleForRestart(
        row({ id: "a", status: "error", endedReason: "crashed", restartPolicy: { ...BASE_POLICY, on: ["error"] } }),
      ),
    ).toBe(false)
  })

  it("does NOT restart an unexpected error when the policy only opts into \"crashed\"", () => {
    expect(
      isEligibleForRestart(
        row({ id: "a", status: "error", restartPolicy: { ...BASE_POLICY, on: ["crashed"] } }),
      ),
    ).toBe(false)
  })

  it("does NOT restart a clean exit (status exited, exitCode 0)", () => {
    expect(isEligibleForRestart(row({ id: "a", status: "exited", exitCode: 0 }))).toBe(false)
  })

  it("does NOT restart an operator kill() (status killed, no endedReason)", () => {
    expect(isEligibleForRestart(row({ id: "a", status: "killed" }))).toBe(false)
  })

  it("does NOT restart idle-reaped", () => {
    expect(
      isEligibleForRestart(row({ id: "a", status: "killed", endedReason: "idle-reaped" })),
    ).toBe(false)
  })

  it("does NOT restart daemon-restart", () => {
    expect(
      isEligibleForRestart(row({ id: "a", status: "killed", endedReason: "daemon-restart" })),
    ).toBe(false)
  })

  it("does NOT restart an overBudget kill (status killed, no endedReason — same shape as operator kill)", () => {
    expect(isEligibleForRestart(row({ id: "a", status: "killed" }))).toBe(false)
  })

  it("does NOT restart a killedMidTurn row that isn't otherwise eligible (killedMidTurn alone is not a restart trigger)", () => {
    expect(
      isEligibleForRestart(row({ id: "a", status: "killed", killedMidTurn: true })),
    ).toBe(false)
  })

  it("DOES restart a killedMidTurn crashed row (killedMidTurn doesn't block eligibility — the no-replay invariant is structural, not a gate)", () => {
    expect(
      isEligibleForRestart(
        row({ id: "a", status: "error", endedReason: "crashed", killedMidTurn: true }),
      ),
    ).toBe(true)
  })

  it("does NOT restart a non-agent-cli kind", () => {
    expect(
      isEligibleForRestart(
        row({ id: "a", kind: "terminal", status: "error", endedReason: "crashed" }),
      ),
    ).toBe(false)
  })
})

// ── Layer 2: backoff curve + rolling-window crash-loop cap ─────────────────

describe("computeBackoffMs", () => {
  it("follows base*factor^attempt, capped at maxDelayMs", () => {
    const policy: RestartPolicy = { ...BASE_POLICY, baseDelayMs: 1_000, factor: 2, maxDelayMs: 10_000 }
    expect(computeBackoffMs(policy, 0)).toBe(1_000)
    expect(computeBackoffMs(policy, 1)).toBe(2_000)
    expect(computeBackoffMs(policy, 2)).toBe(4_000)
    expect(computeBackoffMs(policy, 3)).toBe(8_000)
    expect(computeBackoffMs(policy, 4)).toBe(10_000) // 16_000 capped
    expect(computeBackoffMs(policy, 10)).toBe(10_000)
  })
})

describe("evaluateRestartDecision", () => {
  const NOW = Date.parse("2026-07-23T01:00:00Z")

  it("schedules the first restart at baseDelayMs from now, attempt 0 → 1", () => {
    const desc = row({ id: "a", status: "error", endedReason: "crashed" })
    const decision = evaluateRestartDecision(desc, NOW)
    expect(decision.action).toBe("schedule")
    if (decision.action !== "schedule") throw new Error("unreachable")
    expect(decision.nextRestartAt).toBe(new Date(NOW + 1_000).toISOString())
    expect(decision.restartAttempts).toBe(1)
    expect(decision.recentRestartAts).toEqual([new Date(NOW).toISOString()])
    expect(decision.lastRestartAt).toBe(new Date(NOW).toISOString())
  })

  it("compounds the backoff on successive attempts", () => {
    const desc = row({ id: "a", status: "error", endedReason: "crashed", restartAttempts: 2 })
    const decision = evaluateRestartDecision(desc, NOW)
    expect(decision.action).toBe("schedule")
    if (decision.action !== "schedule") throw new Error("unreachable")
    // baseDelayMs(1000) * factor(2)^2 = 4000
    expect(decision.nextRestartAt).toBe(new Date(NOW + 4_000).toISOString())
    expect(decision.restartAttempts).toBe(3)
  })

  it("gives up once maxRetries restarts have landed within windowMs", () => {
    const recent = [
      new Date(NOW - 10_000).toISOString(),
      new Date(NOW - 20_000).toISOString(),
      new Date(NOW - 30_000).toISOString(),
    ]
    const desc = row({
      id: "a",
      status: "error",
      endedReason: "crashed",
      recentRestartAts: recent,
      restartAttempts: 3,
    })
    const decision = evaluateRestartDecision(desc, NOW)
    expect(decision.action).toBe("give-up")
    if (decision.action !== "give-up") throw new Error("unreachable")
    expect(decision.message).toContain("[crash-loop]")
    expect(decision.message).toContain("gave up after 3 restarts")
  })

  it("does NOT count restarts that have aged out of the window", () => {
    const desc = row({
      id: "a",
      status: "error",
      endedReason: "crashed",
      // All three are OLDER than windowMs (60_000) — none should count.
      recentRestartAts: [
        new Date(NOW - 61_000).toISOString(),
        new Date(NOW - 70_000).toISOString(),
        new Date(NOW - 90_000).toISOString(),
      ],
      restartAttempts: 3,
    })
    const decision = evaluateRestartDecision(desc, NOW)
    expect(decision.action).toBe("schedule")
  })

  it("drops unparseable timestamps from the rolling window rather than counting them", () => {
    const desc = row({
      id: "a",
      status: "error",
      endedReason: "crashed",
      recentRestartAts: ["not-a-date", "also-not-a-date"],
      restartAttempts: 0,
    })
    const decision = evaluateRestartDecision(desc, NOW)
    expect(decision.action).toBe("schedule")
    if (decision.action !== "schedule") throw new Error("unreachable")
    expect(decision.recentRestartAts).toEqual([new Date(NOW).toISOString()])
  })
})

// ── Layer 3: runRestartSweepPass — candidate selection (stub registry) ─────

function stubSweepRegistry(rows: SessionDescriptor[], opts?: { resuming?: Set<string>; failIds?: Set<string> }) {
  const triggered: string[] = []
  const registry: RestartSchedulerRegistry = {
    get: id => rows.find(r => r.id === id),
    list: () => rows,
    isResuming: id => opts?.resuming?.has(id) ?? false,
    triggerResume: async id => {
      triggered.push(id)
      return !(opts?.failIds?.has(id) ?? false)
    },
    applyRestartSchedule: () => true,
    giveUpRestart: () => true,
  }
  return { registry, triggered }
}

describe("runRestartSweepPass", () => {
  const NOW = Date.parse("2026-07-23T01:00:00Z")
  const now = (): number => NOW

  it("is OFF when restartSweepIntervalMs is non-positive/undefined", async () => {
    const { registry, triggered } = stubSweepRegistry([row({ id: "a", nextRestartAt: new Date(NOW - 1).toISOString() })])
    expect(await runRestartSweepPass({ registry, restartSweepIntervalMs: 0, now })).toEqual({
      enabled: false,
      candidates: 0,
      resumed: 0,
      ids: [],
    })
    expect(
      (await runRestartSweepPass({ registry, restartSweepIntervalMs: undefined, now })).enabled,
    ).toBe(false)
    expect(triggered).toEqual([])
  })

  it("executes a row whose nextRestartAt has landed", async () => {
    const { registry, triggered } = stubSweepRegistry([
      row({ id: "due", nextRestartAt: new Date(NOW - 1_000).toISOString() }),
    ])
    const summary = await runRestartSweepPass({ registry, restartSweepIntervalMs: 5_000, now })
    expect(summary).toEqual({ enabled: true, candidates: 1, resumed: 1, ids: ["due"] })
    expect(triggered).toEqual(["due"])
  })

  it("skips a row whose nextRestartAt is still in the future", async () => {
    const { registry, triggered } = stubSweepRegistry([
      row({ id: "not-yet", nextRestartAt: new Date(NOW + 60_000).toISOString() }),
    ])
    const summary = await runRestartSweepPass({ registry, restartSweepIntervalMs: 5_000, now })
    expect(summary.candidates).toBe(0)
    expect(triggered).toEqual([])
  })

  it("skips a row with no nextRestartAt at all", async () => {
    const { registry, triggered } = stubSweepRegistry([row({ id: "idle" })])
    const summary = await runRestartSweepPass({ registry, restartSweepIntervalMs: 5_000, now })
    expect(summary.candidates).toBe(0)
    expect(triggered).toEqual([])
  })

  it("skips a due row that's already resuming (guards against double-scheduling)", async () => {
    const { registry, triggered } = stubSweepRegistry(
      [row({ id: "mid-resume", nextRestartAt: new Date(NOW - 1_000).toISOString() })],
      { resuming: new Set(["mid-resume"]) },
    )
    const summary = await runRestartSweepPass({ registry, restartSweepIntervalMs: 5_000, now })
    expect(summary.candidates).toBe(0)
    expect(triggered).toEqual([])
  })

  it("counts a due row as a candidate even when the resume fails (attempted but not resumed)", async () => {
    const { registry, triggered } = stubSweepRegistry(
      [row({ id: "flaky", nextRestartAt: new Date(NOW - 1_000).toISOString() })],
      { failIds: new Set(["flaky"]) },
    )
    const summary = await runRestartSweepPass({ registry, restartSweepIntervalMs: 5_000, now })
    expect(summary).toEqual({ enabled: true, candidates: 1, resumed: 0, ids: ["flaky"] })
    expect(triggered).toEqual(["flaky"])
  })
})

// ── Layer 4: createRestartScheduler — the event-driven half ────────────────

describe("createRestartScheduler", () => {
  function stubEventRegistry(desc: SessionDescriptor) {
    const applied: Array<{ id: string; update: unknown }> = []
    const gaveUp: Array<{ id: string; message: string }> = []
    const registry: RestartSchedulerRegistry = {
      get: id => (id === desc.id ? desc : undefined),
      list: () => [desc],
      isResuming: () => false,
      triggerResume: async () => true,
      applyRestartSchedule: (id, update) => {
        applied.push({ id, update })
        return true
      },
      giveUpRestart: (id, message) => {
        gaveUp.push({ id, message })
        return true
      },
    }
    return { registry, applied, gaveUp }
  }

  it("schedules a restart on an eligible session:exited", () => {
    const desc = row({ id: "a", status: "error", endedReason: "crashed" })
    const { registry, applied } = stubEventRegistry(desc)
    const bus = createSessionEventBus()
    const scheduler = createRestartScheduler({ registry, sessionEvents: bus, now: () => Date.parse("2026-07-23T01:00:00Z") })
    const ev: SessionExitedEvent = { type: "session:exited", sessionId: "a", status: "error", reason: "crashed", ts: "2026-07-23T01:00:00Z" }
    bus.emit(ev)
    expect(applied).toHaveLength(1)
    expect(applied[0]!.id).toBe("a")
    scheduler.dispose()
  })

  it("gives up (never schedules) once the crash-loop cap is tripped", () => {
    const desc = row({
      id: "a",
      status: "error",
      endedReason: "crashed",
      recentRestartAts: [
        new Date(Date.parse("2026-07-23T00:59:50Z")).toISOString(),
        new Date(Date.parse("2026-07-23T00:59:40Z")).toISOString(),
        new Date(Date.parse("2026-07-23T00:59:30Z")).toISOString(),
      ],
    })
    const { registry, applied, gaveUp } = stubEventRegistry(desc)
    const bus = createSessionEventBus()
    const scheduler = createRestartScheduler({ registry, sessionEvents: bus, now: () => Date.parse("2026-07-23T01:00:00Z") })
    bus.emit({ type: "session:exited", sessionId: "a", status: "error", reason: "crashed", ts: "2026-07-23T01:00:00Z" })
    expect(applied).toEqual([])
    expect(gaveUp).toHaveLength(1)
    expect(gaveUp[0]!.message).toContain("[crash-loop]")
    scheduler.dispose()
  })

  it("ignores an ineligible session:exited (no restartPolicy)", () => {
    const desc = row({ id: "a", status: "error", endedReason: "crashed", restartPolicy: undefined })
    const { registry, applied, gaveUp } = stubEventRegistry(desc)
    const bus = createSessionEventBus()
    const scheduler = createRestartScheduler({ registry, sessionEvents: bus })
    bus.emit({ type: "session:exited", sessionId: "a", status: "error", reason: "crashed", ts: "2026-07-23T01:00:00Z" })
    expect(applied).toEqual([])
    expect(gaveUp).toEqual([])
    scheduler.dispose()
  })

  it("ignores a clean-exit session:exited even with a restartPolicy set", () => {
    const desc = row({ id: "a", status: "exited", exitCode: 0 })
    const { registry, applied, gaveUp } = stubEventRegistry(desc)
    const bus = createSessionEventBus()
    const scheduler = createRestartScheduler({ registry, sessionEvents: bus })
    bus.emit({ type: "session:exited", sessionId: "a", status: "exited", exitCode: 0, ts: "2026-07-23T01:00:00Z" })
    expect(applied).toEqual([])
    expect(gaveUp).toEqual([])
    scheduler.dispose()
  })

  it("unsubscribes on dispose()", () => {
    const desc = row({ id: "a", status: "error", endedReason: "crashed" })
    const { registry, applied } = stubEventRegistry(desc)
    const bus = createSessionEventBus()
    const scheduler = createRestartScheduler({ registry, sessionEvents: bus })
    scheduler.dispose()
    bus.emit({ type: "session:exited", sessionId: "a", status: "error", reason: "crashed", ts: "2026-07-23T01:00:00Z" })
    expect(applied).toEqual([])
  })
})

// ── Layer 5: end-to-end against a real registry ─────────────────────────────

function liveAgentSession(sessionId: string, closed: { value: boolean }): AgentSessionLike {
  return {
    sessionId,
    pid: 4242,
    async *send() {
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {
      closed.value = true
    },
  }
}

describe("end-to-end: crash → schedule → sweep → resumed", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "restart-scheduler-"))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("a markCrashed row with a restartPolicy is scheduled, then the sweep resumes it", async () => {
    const bus = createSessionEventBus()
    let resumeCalls = 0
    const reg = createSessionsRegistry({
      persist: false,
      transcriptDir: tmp,
      sessionEvents: bus,
      resumeAgent: async ({ resumeSessionId }) => {
        resumeCalls++
        return liveAgentSession(resumeSessionId, { value: false })
      },
    })
    const scheduler = createRestartScheduler({ registry: reg, sessionEvents: bus })

    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-1", { value: false }),
      adapterSlug: "claude-code",
      restartPolicy: BASE_POLICY,
    })

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" })
    })
    expect(reg.markCrashed(desc.id)).toBe(true)
    killSpy.mockRestore()

    // The event-driven half scheduled a restart.
    const scheduled = reg.get(desc.id)!
    expect(scheduled.nextRestartAt).toBeTruthy()
    expect(scheduled.restartAttempts).toBe(1)
    expect(scheduled.recentRestartAts).toHaveLength(1)

    // The sweep, told "now" is past nextRestartAt, executes it.
    const future = Date.parse(scheduled.nextRestartAt!) + 1
    const summary = await runRestartSweepPass({
      registry: reg,
      restartSweepIntervalMs: 1_000,
      now: () => future,
    })
    expect(summary.resumed).toBe(1)
    expect(resumeCalls).toBe(1)
    expect(reg.get(desc.id)?.status).toBe("running")

    scheduler.dispose()
    reg.shutdown()
  })

  it("a session that crashes, resumes, then crashes AGAIN is scheduled a second time (pins the exitedEmitted reset fix)", async () => {
    const bus = createSessionEventBus()
    const exitedEvents: string[] = []
    bus.on("session:exited", ev => exitedEvents.push(ev.sessionId))
    const reg = createSessionsRegistry({
      persist: false,
      transcriptDir: tmp,
      sessionEvents: bus,
      resumeAgent: async ({ resumeSessionId }) => liveAgentSession(resumeSessionId, { value: false }),
    })
    const scheduler = createRestartScheduler({ registry: reg, sessionEvents: bus })

    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-1", { value: false }),
      adapterSlug: "claude-code",
      restartPolicy: BASE_POLICY,
    })

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" })
    })

    // First crash.
    expect(reg.markCrashed(desc.id)).toBe(true)
    const firstSchedule = reg.get(desc.id)!.nextRestartAt
    expect(firstSchedule).toBeTruthy()

    // Sweep resumes it.
    await runRestartSweepPass({
      registry: reg,
      restartSweepIntervalMs: 1_000,
      now: () => Date.parse(firstSchedule!) + 1,
    })
    expect(reg.get(desc.id)?.status).toBe("running")

    // Second crash of the SAME (in-memory) row.
    expect(reg.markCrashed(desc.id)).toBe(true)
    const secondSchedule = reg.get(desc.id)!.nextRestartAt
    expect(secondSchedule).toBeTruthy()
    expect(reg.get(desc.id)!.restartAttempts).toBe(2)

    killSpy.mockRestore()
    expect(exitedEvents).toEqual([desc.id, desc.id])

    scheduler.dispose()
    reg.shutdown()
  })

  it("gives up after maxRetries restarts within the window — the row stays dead and un-resumed", async () => {
    const bus = createSessionEventBus()
    const reg = createSessionsRegistry({
      persist: false,
      transcriptDir: tmp,
      sessionEvents: bus,
      resumeAgent: async ({ resumeSessionId }) => liveAgentSession(resumeSessionId, { value: false }),
    })
    const scheduler = createRestartScheduler({ registry: reg, sessionEvents: bus })

    const tightPolicy: RestartPolicy = { ...BASE_POLICY, maxRetries: 1, baseDelayMs: 10, maxDelayMs: 10 }
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: liveAgentSession("acp-1", { value: false }),
      adapterSlug: "claude-code",
      restartPolicy: tightPolicy,
    })

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" })
    })

    // First crash: schedules (0 recent restarts < maxRetries=1).
    expect(reg.markCrashed(desc.id)).toBe(true)
    const firstSchedule = reg.get(desc.id)!.nextRestartAt
    expect(firstSchedule).toBeTruthy()
    await runRestartSweepPass({ registry: reg, restartSweepIntervalMs: 1_000, now: () => Date.parse(firstSchedule!) + 1 })
    expect(reg.get(desc.id)?.status).toBe("running")

    // Second crash: 1 recent restart >= maxRetries=1 → give up, no schedule.
    expect(reg.markCrashed(desc.id)).toBe(true)
    const after = reg.get(desc.id)!
    expect(after.nextRestartAt).toBeUndefined()
    expect(after.status).toBe("error")

    killSpy.mockRestore()
    scheduler.dispose()
    reg.shutdown()
  })
})
