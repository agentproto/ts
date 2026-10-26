/**
 * ReactionRunner trace lines: exactly one structured line per terminal
 * transition, with store-redacted reasons and no line for a skipped event.
 */

import { describe, expect, it, vi } from "vitest"

import { createSessionEventBus, type SessionCompletedEvent, type SessionEvent } from "../session-event-bus.js"
import {
  createReactionReceiptStore,
  createReactionRunner,
  type ReactionBinding,
  type ReactionTargetOutcome,
  type ReactionRunnerOptions,
} from "../action-hooks/index.js"

const EVENT = "agentproto:session-completed"

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return {
    now: () => t,
    advance: ms => {
      t += ms
    },
  }
}

const completed = (over: Partial<SessionCompletedEvent> = {}): SessionCompletedEvent => ({
  type: EVENT,
  sessionId: "sess-1",
  occurrenceId: "exit:1",
  basis: "outcome",
  endedAt: "2026-01-01T00:00:00.000Z",
  ts: "2026-01-01T00:00:00.000Z",
  ...over,
})

function makeBinding(over: Partial<ReactionBinding> = {}): ReactionBinding {
  return {
    bindingId: "bind-1",
    event: EVENT,
    actionId: "brain:ingest",
    configRevision: "cfg-1",
    maxAttempts: 3,
    reactionDepth: 0,
    occurrenceIdOf: (event: SessionEvent) =>
      event.type === EVENT ? (event as SessionCompletedEvent).occurrenceId : undefined,
    target: { actionId: "brain:ingest", idempotent: true, run: async () => ({ ok: true }) },
    ...over,
  }
}

describe("reaction runner trace", () => {
  it("emits one sanitized line per terminal transition and none for a skipped event", async () => {
    const setup = (
      binding: ReactionBinding,
      trace: (line: string) => void,
      over: Partial<ReactionRunnerOptions> = {},
    ) => {
      const c = clock()
      const store = createReactionReceiptStore({ persist: false, nowMs: c.now, log: () => {} })
      const runner = createReactionRunner({
        bus: createSessionEventBus(),
        store,
        bindings: [binding],
        nowMs: c.now,
        log: () => {},
        trace,
        ...over,
      })
      return { c, store, runner }
    }

    const doneLines: string[] = []
    const doneTarget = vi.fn(async () => {
      doneCase.c.advance(25)
      return { ok: true, outcomeRef: "ref" }
    })
    const doneCase = setup(makeBinding({ target: { actionId: "brain:ingest", idempotent: true, run: doneTarget } }), line => doneLines.push(line))
    await doneCase.runner.handleEvent(completed({ occurrenceId: "exit:done" }), "exit:done")
    expect(doneLines).toHaveLength(1)
    expect(doneLines[0]).toContain("status=done")
    expect(doneLines[0]).toContain("depth=0")
    expect(doneLines[0]).toContain("attempt=1")
    expect(doneLines[0]).toContain("latencyMs=25")
    expect(doneLines[0]).toContain("queueAgeMs=0")
    expect(doneLines[0]).not.toContain("reason=")

    const failedLines: string[] = []
    const failedTarget = async () => {
      throw new Error("boom https://api.example/v1?token=SECRET")
    }
    const failedCase = setup(makeBinding({ target: { actionId: "brain:ingest", idempotent: true, run: failedTarget } }), line => failedLines.push(line))
    await failedCase.runner.handleEvent(completed({ occurrenceId: "exit:failed" }), "exit:failed")
    expect(failedLines).toHaveLength(1)
    expect(failedLines[0]).toContain("status=failed")
    expect(failedLines[0]).toContain("retryAt=")
    expect(failedLines[0]).toContain("reason=boom_https://api.example")
    expect(failedLines[0]).not.toContain("SECRET")
    expect(failedLines[0]).not.toContain("/v1")

    const deadLines: string[] = []
    const deadOutcome: ReactionTargetOutcome = { ok: false, retryable: false, error: "fatal" }
    const deadCase = setup(makeBinding({ target: { actionId: "brain:ingest", idempotent: true, run: async () => deadOutcome } }), line => deadLines.push(line))
    await deadCase.runner.handleEvent(completed({ occurrenceId: "exit:dead" }), "exit:dead")
    expect(deadLines).toHaveLength(1)
    expect(deadLines[0]).toContain("status=dead")
    expect(deadLines[0]).toContain("reason=fatal")

    const capRun = vi.fn(async () => ({ ok: true }) as ReactionTargetOutcome)
    const capLines: string[] = []
    const capCase = setup(
      makeBinding({ reactionDepth: 4, target: { actionId: "brain:ingest", idempotent: true, run: capRun } }),
      line => capLines.push(line),
    )
    await capCase.runner.handleEvent(completed({ occurrenceId: "exit:cap" }), "exit:cap")
    expect(capRun).not.toHaveBeenCalled()
    expect(capLines).toHaveLength(1)
    expect(capLines[0]).toContain("status=dead")
    expect(capLines[0]).toContain("depth=4")
    expect(capLines[0]).toContain("reason=recursion_cap")

    const skipLines: string[] = []
    const skipCase = setup(makeBinding({ shouldHandle: () => false }), line => skipLines.push(line))
    await skipCase.runner.handleEvent(completed({ occurrenceId: "exit:skip" }), "exit:skip")
    expect(skipLines).toEqual([])

    const spaceLines: string[] = []
    const spaceOutcome: ReactionTargetOutcome = { ok: false, retryable: false, error: "bad  value\nnext\tline" }
    const spaceCase = setup(makeBinding({ target: { actionId: "brain:ingest", idempotent: true, run: async () => spaceOutcome } }), line => spaceLines.push(line))
    await spaceCase.runner.handleEvent(completed({ occurrenceId: "exit:space" }), "exit:space")
    expect(spaceLines).toHaveLength(1)
    expect(spaceLines[0]).toContain("reason=bad_value_next_line")
    expect(spaceLines[0]).not.toContain("\n")
    expect(spaceLines[0]?.split(" ").every(part => part.length > 0)).toBe(true)

    const throwTraceCase = setup(makeBinding(), () => {
      throw new Error("trace exploded")
    })
    await throwTraceCase.runner.handleEvent(completed({ occurrenceId: "exit:trace-throw" }), "exit:trace-throw")
    expect(throwTraceCase.store.rows().map(row => row.status)).toEqual(["done"])

    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    try {
      const defaultCase = setup(makeBinding(), () => {}, { trace: undefined })
      await defaultCase.runner.handleEvent(completed({ occurrenceId: "exit:default" }), "exit:default")
      expect(info).toHaveBeenCalledWith(expect.stringContaining("[reaction-runner]"))
      expect(info).toHaveBeenCalledWith(expect.stringContaining("status=done"))
    } finally {
      info.mockRestore()
    }
  })
})
