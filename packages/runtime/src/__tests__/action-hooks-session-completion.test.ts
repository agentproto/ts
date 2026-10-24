/**
 * Session completion: occurrence ids, the pure derivation, and the bus wiring
 * for `agentproto:session-completed`.
 */

import { describe, expect, it, vi } from "vitest"

import {
  deriveSessionCompletion,
  sessionCompletionOccurrenceId,
  wireSessionCompletion,
  type SessionCompletionFacts,
} from "../action-hooks/index.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { SessionCompletedEvent, SessionExitedEvent } from "../session-event-bus.js"

const ENDED_AT = "2026-10-24T01:02:03.000Z"

function exited(sessionId: string, status: SessionExitedEvent["status"] = "exited"): SessionExitedEvent {
  return { type: "session:exited", sessionId, status, ts: ENDED_AT }
}

function policyPassed(sessionId: string): { type: "policy:passed"; policyId: string; sessionId: string; ts: string } {
  return { type: "policy:passed", policyId: "p1", sessionId, ts: ENDED_AT }
}

function collect(bus: ReturnType<typeof createSessionEventBus>): SessionCompletedEvent[] {
  const seen: SessionCompletedEvent[] = []
  bus.on("agentproto:session-completed", ev => {
    seen.push(ev)
  })
  return seen
}

describe("sessionCompletionOccurrenceId", () => {
  it("builds exit:<endedAt> for a good endedAt", () => {
    expect(sessionCompletionOccurrenceId(ENDED_AT)).toBe(`exit:${ENDED_AT}`)
  })

  it("returns undefined for undefined", () => {
    expect(sessionCompletionOccurrenceId(undefined)).toBeUndefined()
  })

  it("returns undefined for the empty string", () => {
    expect(sessionCompletionOccurrenceId("")).toBeUndefined()
  })

  it("returns undefined for a string with a space", () => {
    expect(sessionCompletionOccurrenceId("2026-10-24 01:02:03")).toBeUndefined()
  })

  it("returns undefined for a string with a slash", () => {
    expect(sessionCompletionOccurrenceId("2026/10/24")).toBeUndefined()
  })
})

describe("deriveSessionCompletion", () => {
  it("uses basis outcome for a done verdict on an exited session", () => {
    const facts: SessionCompletionFacts = {
      status: "exited",
      endedAt: ENDED_AT,
      outcome: { verdict: "done" },
    }
    expect(deriveSessionCompletion(facts)).toEqual({
      occurrenceId: `exit:${ENDED_AT}`,
      basis: "outcome",
      endedAt: ENDED_AT,
    })
  })

  it("uses basis outcome for an operator-completed termination on a killed session", () => {
    const facts: SessionCompletionFacts = {
      status: "killed",
      endedAt: ENDED_AT,
      outcome: { termination: { reason: "operator-completed" } },
    }
    expect(deriveSessionCompletion(facts)?.basis).toBe("outcome")
  })

  it("returns undefined for a plain killed exit", () => {
    const facts: SessionCompletionFacts = { status: "killed", endedAt: ENDED_AT }
    expect(deriveSessionCompletion(facts)).toBeUndefined()
  })

  it("returns undefined for an error exit", () => {
    const facts: SessionCompletionFacts = {
      status: "error",
      endedAt: ENDED_AT,
      outcome: { verdict: "failed" },
    }
    expect(deriveSessionCompletion(facts)).toBeUndefined()
  })

  it("returns undefined for an idle-reaped kill", () => {
    const facts: SessionCompletionFacts = {
      status: "killed",
      endedAt: ENDED_AT,
      outcome: { termination: { reason: "idle-reaped" } },
    }
    expect(deriveSessionCompletion(facts)).toBeUndefined()
  })

  it("returns undefined for a running session even with a done verdict", () => {
    const facts: SessionCompletionFacts = {
      status: "running",
      endedAt: ENDED_AT,
      outcome: { verdict: "done" },
    }
    expect(deriveSessionCompletion(facts)).toBeUndefined()
  })

  it("returns undefined without an endedAt", () => {
    const facts: SessionCompletionFacts = { status: "exited", outcome: { verdict: "done" } }
    expect(deriveSessionCompletion(facts)).toBeUndefined()
  })

  it("uses basis policy for a killed exit when a policy passed", () => {
    const facts: SessionCompletionFacts = { status: "killed", endedAt: ENDED_AT }
    expect(deriveSessionCompletion(facts, { policyPassed: true })).toEqual({
      occurrenceId: `exit:${ENDED_AT}`,
      basis: "policy",
      endedAt: ENDED_AT,
    })
  })

  it("prefers basis outcome when both hold", () => {
    const facts: SessionCompletionFacts = {
      status: "exited",
      endedAt: ENDED_AT,
      outcome: { verdict: "done" },
    }
    expect(deriveSessionCompletion(facts, { policyPassed: true })?.basis).toBe("outcome")
  })
})

describe("wireSessionCompletion", () => {
  it("emits exactly one event for a completed exit with the right fields", () => {
    const bus = createSessionEventBus()
    const seen = collect(bus)
    const facts: SessionCompletionFacts & { label?: string } = {
      status: "exited",
      endedAt: ENDED_AT,
      outcome: { verdict: "done" },
      label: "worker",
    }
    wireSessionCompletion({
      bus,
      getSession: id => (id === "s1" ? facts : undefined),
      now: () => new Date("2026-10-24T02:00:00.000Z"),
    })

    bus.emit(exited("s1"))

    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({
      type: "agentproto:session-completed",
      sessionId: "s1",
      occurrenceId: `exit:${ENDED_AT}`,
      basis: "outcome",
      endedAt: ENDED_AT,
      label: "worker",
      ts: "2026-10-24T02:00:00.000Z",
    })
  })

  it("emits once when the same session:exited is emitted twice", () => {
    const bus = createSessionEventBus()
    const seen = collect(bus)
    wireSessionCompletion({
      bus,
      getSession: () => ({ status: "exited", endedAt: ENDED_AT, outcome: { verdict: "done" } }),
    })

    bus.emit(exited("s1"))
    bus.emit(exited("s1"))

    expect(seen).toHaveLength(1)
  })

  it("emits nothing for a killed exit without a policy", () => {
    const bus = createSessionEventBus()
    const seen = collect(bus)
    wireSessionCompletion({
      bus,
      getSession: () => ({ status: "killed", endedAt: ENDED_AT }),
    })

    bus.emit(exited("s1", "killed"))

    expect(seen).toHaveLength(0)
  })

  it("emits once with basis policy when a policy passed before the killed exit", () => {
    const bus = createSessionEventBus()
    const seen = collect(bus)
    const facts: SessionCompletionFacts = { status: "running", endedAt: ENDED_AT }
    wireSessionCompletion({ bus, getSession: () => facts })

    bus.emit(policyPassed("s1"))
    expect(seen).toHaveLength(0)

    facts.status = "killed"
    bus.emit(exited("s1", "killed"))

    expect(seen).toHaveLength(1)
    expect(seen[0]?.basis).toBe("policy")
  })

  it("emits once when a policy passes after the session is already terminal", () => {
    const bus = createSessionEventBus()
    const seen = collect(bus)
    wireSessionCompletion({
      bus,
      getSession: () => ({ status: "killed", endedAt: ENDED_AT }),
    })

    bus.emit(policyPassed("s1"))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.basis).toBe("policy")

    bus.emit(exited("s1", "killed"))
    expect(seen).toHaveLength(1)
  })

  it("emits nothing for a policy pass on a running session until the exit", () => {
    const bus = createSessionEventBus()
    const seen = collect(bus)
    const facts: SessionCompletionFacts = { status: "running", endedAt: ENDED_AT }
    wireSessionCompletion({ bus, getSession: () => facts })

    bus.emit(policyPassed("s1"))
    expect(seen).toHaveLength(0)

    facts.status = "exited"
    bus.emit(exited("s1"))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.basis).toBe("policy")
  })

  it("emits nothing for a session without endedAt", () => {
    const bus = createSessionEventBus()
    const seen = collect(bus)
    wireSessionCompletion({
      bus,
      getSession: () => ({ status: "exited", outcome: { verdict: "done" } }),
    })

    bus.emit(exited("s1"))

    expect(seen).toHaveLength(0)
  })

  it("does not throw out of bus.emit when getSession throws, and logs", () => {
    const bus = createSessionEventBus()
    const log = vi.fn()
    wireSessionCompletion({
      bus,
      getSession: () => {
        throw new Error("boom")
      },
      log,
    })

    expect(() => bus.emit(exited("s1"))).not.toThrow()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]?.[0]).toContain("boom")
  })

  it("does not throw out of bus.emit when a bus consumer throws, and logs", () => {
    const bus = createSessionEventBus()
    const log = vi.fn()
    wireSessionCompletion({
      bus,
      getSession: () => ({ status: "exited", endedAt: ENDED_AT, outcome: { verdict: "done" } }),
      log,
    })
    bus.on("agentproto:session-completed", () => {
      throw new Error("consumer boom")
    })

    expect(() => bus.emit(exited("s1"))).not.toThrow()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]?.[0]).toContain("consumer boom")
  })

  it("stops emitting after the returned unsubscribe runs", () => {
    const bus = createSessionEventBus()
    const seen = collect(bus)
    const unsubscribe = wireSessionCompletion({
      bus,
      getSession: () => ({ status: "exited", endedAt: ENDED_AT, outcome: { verdict: "done" } }),
    })

    unsubscribe()
    bus.emit(exited("s1"))

    expect(seen).toHaveLength(0)
  })

  it("accepts the new event type in the bus union", () => {
    const bus = createSessionEventBus()
    const handler = (ev: SessionCompletedEvent): string => ev.occurrenceId
    const unsubscribe = bus.on("agentproto:session-completed", handler)
    expect(typeof unsubscribe).toBe("function")
    unsubscribe()
  })
})
