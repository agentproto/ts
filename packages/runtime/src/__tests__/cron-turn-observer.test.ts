/**
 * Unit tests for the production `CronTurnObserver` — the classification of a
 * spawned session's first turn into `produced` / `empty` / `errored` /
 * `timeout`, over the shared `monitorSessionWait` core.
 */

import { describe, it, expect, vi } from "vitest"

import { createSessionTurnObserver } from "../cron-turn-observer.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"

function makeRegistry(descs: Record<string, SessionDescriptor>): SessionsRegistry {
  return {
    get: vi.fn((id: string) => descs[id]),
    findByIdOrName: vi.fn((q: string) => descs[q]),
    incWatchers: vi.fn(),
    decWatchers: vi.fn(),
    list: vi.fn(() => Object.values(descs)),
  } as unknown as SessionsRegistry
}

function desc(id: string, overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id,
    kind: "agent-cli",
    workspaceSlug: "test",
    command: "mock",
    pid: null,
    status: "running",
    startedAt: new Date().toISOString(),
    ...overrides,
  }
}

function observerFor(descriptors: Record<string, SessionDescriptor>) {
  const registry = makeRegistry(descriptors)
  const sessionEvents = createSessionEventBus()
  const eventRing = createEventRing()
  return createSessionTurnObserver({ registry, sessionEvents, eventRing })
}

describe("createSessionTurnObserver — outcome classification", () => {
  it("classifies a productive completed turn as produced and reads tokensOut", async () => {
    const observer = observerFor({
      s1: desc("s1", { turnsCompleted: 1, busy: false, tokensOut: 42 }),
    })
    const obs = await observer({ sessionId: "s1", jobId: "cron_1", timeoutMs: 5_000 })
    expect(obs.outcome).toBe("produced")
    expect(obs.tokensOut).toBe(42)
    expect(obs.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("classifies a zero-token turn as empty", async () => {
    const observer = observerFor({
      s1: desc("s1", { turnsCompleted: 1, busy: false, tokensOut: 0 }),
    })
    const obs = await observer({ sessionId: "s1", jobId: "cron_1", timeoutMs: 5_000 })
    expect(obs.outcome).toBe("empty")
    expect(obs.tokensOut).toBe(0)
  })

  it("classifies a turn-end flagged empty (no token report) as empty", async () => {
    const observer = observerFor({
      s1: desc("s1", { turnsCompleted: 1, busy: false, lastTurnEmpty: true }),
    })
    const obs = await observer({ sessionId: "s1", jobId: "cron_1", timeoutMs: 5_000 })
    expect(obs.outcome).toBe("empty")
  })

  it("classifies an adapter-reported error turn as errored", async () => {
    const observer = observerFor({
      s1: desc("s1", { turnsCompleted: 1, busy: false, lastTurnReason: "error", lastTurnErrorMessage: "boom" }),
    })
    const obs = await observer({ sessionId: "s1", jobId: "cron_1", timeoutMs: 5_000 })
    expect(obs.outcome).toBe("errored")
    expect(obs.reason).toBe("error")
    expect(obs.error).toBe("boom")
  })

  it("classifies a session that died before completing a turn as errored", async () => {
    const observer = observerFor({
      s1: desc("s1", { status: "exited", turnsCompleted: 0 }),
    })
    const obs = await observer({ sessionId: "s1", jobId: "cron_1", timeoutMs: 5_000 })
    expect(obs.outcome).toBe("errored")
    expect(obs.error).toMatch(/exited before completing a turn/)
  })

  it("classifies a first turn parked on awaiting-input as errored, with the question text", async () => {
    const observer = observerFor({
      s1: desc("s1", {
        turnsCompleted: 1,
        busy: false,
        awaitingInput: true,
        awaitingQuestion: { text: "Approve the deploy?", source: "structured" },
      }),
    })
    const obs = await observer({ sessionId: "s1", jobId: "cron_1", timeoutMs: 5_000 })
    expect(obs.outcome).toBe("errored")
    expect(obs.reason).toBe("awaiting-input")
    expect(obs.error).toBe("blocked awaiting input: Approve the deploy?")
  })

  it("classifies an awaiting-input turn with no question text as errored too", async () => {
    const observer = observerFor({
      s1: desc("s1", { turnsCompleted: 1, busy: false, awaitingInput: true }),
    })
    const obs = await observer({ sessionId: "s1", jobId: "cron_1", timeoutMs: 5_000 })
    expect(obs.outcome).toBe("errored")
    expect(obs.error).toBe("blocked awaiting input")
  })

  it("classifies no turn-end within the bound as timeout", async () => {
    const observer = observerFor({
      s1: desc("s1", { status: "running", turnsCompleted: 0, busy: true }),
    })
    const obs = await observer({ sessionId: "s1", jobId: "cron_1", timeoutMs: 30 })
    expect(obs.outcome).toBe("timeout")
    // Node timers can fire ~1 ms early relative to Date.now(); allow slack.
    expect(obs.durationMs).toBeGreaterThanOrEqual(25)
  })
})
