import { describe, it, expect } from "vitest"
import type { RoutineFrontmatter } from "@agentproto/routine"
import { HooksContractError } from "@agentproto/lifecycle"
import {
  EventBindingError,
  HOST_EVENT_REGISTRATIONS,
  matchEventFilter,
  resolveAgentOnBindings,
  resolveRoutineEventBinding,
  type EventFilter,
} from "../action-hooks/event-bindings.js"
import type { SessionCompletedEvent } from "../session-event-bus.js"

const HEX16 = /^[0-9a-f]{16}$/

function routine(overrides: Record<string, unknown> = {}): RoutineFrontmatter {
  return {
    schema: "routine/v1",
    id: "evt-demo",
    description: "test",
    version: "1.0.0",
    schedule: { kind: "event", on: "turn-end" },
    target: { tool: "worktree_gc", inputs: { apply: true } },
    enabled: true,
    fires_events: [],
    tags: [],
    ...overrides,
  } as unknown as RoutineFrontmatter
}

describe("resolveRoutineEventBinding", () => {
  it("resolves an enabled event routine with its authored target", () => {
    const binding = resolveRoutineEventBinding(
      routine({
        id: "evt-demo",
        schedule: { kind: "event", on: "turn-end" },
        target: { tool: "worktree_gc", inputs: { apply: true } },
      }),
    )
    expect(binding).toBeDefined()
    expect(binding!.bindingId).toBe("routine:evt-demo")
    expect(binding!.event.event).toBe("turn-end")
    expect(binding!.source).toEqual({ kind: "routine", routineId: "evt-demo" })
    expect(binding!.target).toEqual({ tool: "worktree_gc", inputs: { apply: true } })
    expect(binding!.configRevision).toMatch(HEX16)
  })

  it("returns undefined for a cron routine and a disabled event routine", () => {
    const cron = resolveRoutineEventBinding(
      routine({ schedule: { kind: "cron", cron: "0 4 * * *" } }),
    )
    const disabled = resolveRoutineEventBinding(
      routine({ schedule: { kind: "event", on: "turn-end" }, enabled: false }),
    )
    expect(cron).toBeUndefined()
    expect(disabled).toBeUndefined()
  })

  it("accepts a registered host event and resolves aliases to their canonical name", () => {
    const host = resolveRoutineEventBinding(
      routine({ schedule: { kind: "event", on: "agentproto:session-completed" } }),
    )
    expect(host!.event.kind).toBe("host")
    expect(host!.event.event).toBe("agentproto:session-completed")

    const alias = resolveRoutineEventBinding(
      routine({ schedule: { kind: "event", on: "per-turn" } }),
    )
    expect(alias!.event.event).toBe("turn-end")

    expect(() =>
      resolveRoutineEventBinding(
        routine({ schedule: { kind: "event", on: "agentproto:typo" } }),
      ),
    ).toThrow(HooksContractError)
    try {
      resolveRoutineEventBinding(
        routine({ schedule: { kind: "event", on: "agentproto:typo" } }),
      )
    } catch (err) {
      expect((err as HooksContractError).code).toBe("event-ref-host-unregistered")
    }
  })

  it("has a stable configRevision for the same input and a changed one for filter or target edits", () => {
    const base = routine({ schedule: { kind: "event", on: "turn-end", filter: { "a.b": 1 } } })
    const again = routine({ schedule: { kind: "event", on: "turn-end", filter: { "a.b": 1 } } })
    const reordered = routine({ schedule: { kind: "event", on: "turn-end", filter: { "b.c": 2, "a.b": 1 } } })
    const reorderedAgain = routine({ schedule: { kind: "event", on: "turn-end", filter: { "a.b": 1, "b.c": 2 } } })
    const otherFilter = routine({ schedule: { kind: "event", on: "turn-end", filter: { "a.b": 9 } } })
    const otherTarget = routine({
      schedule: { kind: "event", on: "turn-end", filter: { "a.b": 1 } },
      target: { tool: "other_tool" },
    })

    expect(resolveRoutineEventBinding(base)!.configRevision).toBe(
      resolveRoutineEventBinding(again)!.configRevision,
    )
    expect(resolveRoutineEventBinding(reordered)!.configRevision).toBe(
      resolveRoutineEventBinding(reorderedAgain)!.configRevision,
    )
    expect(resolveRoutineEventBinding(base)!.configRevision).not.toBe(
      resolveRoutineEventBinding(otherFilter)!.configRevision,
    )
    expect(resolveRoutineEventBinding(base)!.configRevision).not.toBe(
      resolveRoutineEventBinding(otherTarget)!.configRevision,
    )
  })

  it("keeps a valid filter, rejects invalid filters and omits an empty one", () => {
    const valid = resolveRoutineEventBinding(
      routine({ schedule: { kind: "event", on: "turn-end", filter: { "a.b": "x", "c": null } } }),
    )
    expect(valid!.filter).toEqual({ "a.b": "x", "c": null })

    const empty = resolveRoutineEventBinding(
      routine({ schedule: { kind: "event", on: "turn-end", filter: {} } }),
    )
    expect(empty).not.toHaveProperty("filter")

    const invalidFilters: Array<{ key: string; filter: Record<string, unknown> }> = [
      { key: "value", filter: { value: ["x"] } },
      { key: "value", filter: { value: { nested: true } } },
      { key: "a..b", filter: { "a..b": 1 } },
      { key: ".a", filter: { ".a": 1 } },
      { key: "x", filter: { x: Number.NaN } },
    ]
    for (const { key, filter } of invalidFilters) {
      try {
        resolveRoutineEventBinding(
          routine({ schedule: { kind: "event", on: "turn-end", filter } }),
        )
        expect.unreachable(`expected filter-invalid for ${key}`)
      } catch (err) {
        expect(err).toBeInstanceOf(EventBindingError)
        expect((err as EventBindingError).code).toBe("filter-invalid")
        expect((err as Error).message).toContain(key)
      }
    }
  })

  it("rejects an own __proto__ filter key instead of silently dropping it", () => {
    const filter: Record<string, unknown> = { event: "turn-end" }
    Object.defineProperty(filter, "__proto__", {
      value: "x",
      enumerable: true,
      configurable: true,
      writable: true,
    })
    try {
      resolveRoutineEventBinding(
        routine({ schedule: { kind: "event", on: "turn-end", filter } }),
      )
      expect.unreachable("expected filter-invalid for __proto__")
    } catch (err) {
      expect(err).toBeInstanceOf(EventBindingError)
      expect((err as EventBindingError).code).toBe("filter-invalid")
      expect((err as Error).message).toContain("__proto__")
    }
  })
})

describe("matchEventFilter", () => {
  it("matches everything when the filter is undefined", () => {
    expect(matchEventFilter(undefined, { any: "thing" })).toBe(true)
  })

  it("matches a nested path and compares the leaf exactly", () => {
    expect(matchEventFilter({ "a.b.c": 3 }, { a: { b: { c: 3 } } })).toBe(true)
    expect(matchEventFilter({ "a.b.c": 4 }, { a: { b: { c: 3 } } })).toBe(false)
  })

  it("does not match a missing path, even when null is expected", () => {
    expect(matchEventFilter({ "a.b": null }, { a: {} })).toBe(false)
  })

  it("matches a leaf null against null", () => {
    expect(matchEventFilter({ "a.b": null }, { a: { b: null } })).toBe(true)
  })

  it("does not walk through an array", () => {
    expect(matchEventFilter({ "a.0": "x" }, { a: ["x"] })).toBe(false)
  })

  it("does not resolve __proto__ or constructor as own paths", () => {
    expect(matchEventFilter({ "__proto__.polluted": true }, {})).toBe(false)
    expect(matchEventFilter({ "__proto__.__proto__": null }, {})).toBe(false)
    expect(matchEventFilter({ "constructor.name": "Object" }, {})).toBe(false)
  })

  it("requires every entry to match", () => {
    const filter: EventFilter = { "a.b": 1, "c": "x" }
    expect(matchEventFilter(filter, { a: { b: 1 }, c: "x" })).toBe(true)
    expect(matchEventFilter(filter, { a: { b: 1 }, c: "y" })).toBe(false)
  })
})

describe("resolveAgentOnBindings", () => {
  it("resolves string and object entries in authoring order with inputs preserved", () => {
    const bindings = resolveAgentOnBindings("agent", {
      "turn-end": "session:a",
      "conversation-end": ["session:b", { action: "session:c", inputs: { k: 1 } }],
    })
    expect(bindings.map(binding => binding.bindingId)).toEqual([
      "agent/on/turn-end/0",
      "agent/on/conversation-end/0",
      "agent/on/conversation-end/1",
    ])
    expect(bindings[2]!.target).toEqual({ action: "session:c", inputs: { k: 1 } })
    expect(bindings[0]!.target).toEqual({ action: "session:a" })
    expect(bindings[0]!.source).toEqual({ kind: "agent-on", agentId: "agent", event: "turn-end", index: 0 })
  })

  it("numbers aliases by canonical event so ids stay distinct", () => {
    const bindings = resolveAgentOnBindings("x", {
      "per-turn": "session:a",
      "turn-end": "session:b",
    })
    expect(bindings.map(binding => binding.bindingId)).toEqual(["x/on/turn-end/0", "x/on/turn-end/1"])
    expect(new Set(bindings.map(binding => binding.bindingId)).size).toBe(2)
  })

  it("returns an empty list for undefined and rejects an empty agent id or empty entry", () => {
    expect(resolveAgentOnBindings("x", undefined)).toEqual([])

    expect(() => resolveAgentOnBindings("", { "turn-end": "session:a" })).toThrow(EventBindingError)
    try {
      resolveAgentOnBindings("", { "turn-end": "session:a" })
    } catch (err) {
      expect((err as EventBindingError).code).toBe("agent-id-invalid")
    }

    expect(() => resolveAgentOnBindings("x", { "turn-end": [] })).toThrow(HooksContractError)
    try {
      resolveAgentOnBindings("x", { "turn-end": [] })
    } catch (err) {
      expect((err as HooksContractError).code).toBe("agent-hook-entry-empty")
    }
  })
})

describe("HOST_EVENT_REGISTRATIONS", () => {
  it("lists the session completion event this runtime emits", () => {
    const completed: SessionCompletedEvent = {
      type: "agentproto:session-completed",
      sessionId: "sess_1",
      occurrenceId: "exit:1",
      basis: "outcome",
      endedAt: "2026-01-01T00:00:00.000Z",
      ts: "2026-01-01T00:00:00.000Z",
    }
    const registration = HOST_EVENT_REGISTRATIONS.find(entry => entry.host === "agentproto")
    expect(registration).toBeDefined()
    expect(registration!.event).toBe(completed.type)
    expect(HOST_EVENT_REGISTRATIONS.map(entry => entry.event)).toContain("agentproto:session-completed")
  })

  it("cannot be mutated at runtime", () => {
    expect(Object.isFrozen(HOST_EVENT_REGISTRATIONS)).toBe(true)
    expect(Object.isFrozen(HOST_EVENT_REGISTRATIONS[0])).toBe(true)
  })
})

describe("resolveAgentOnBindings agent id validation", () => {
  it("rejects malformed agent ids", () => {
    const invalidIds = ["a//b", "/a", "a/", " a", "a b", "a\tb", "a\\b"]
    for (const id of invalidIds) {
      try {
        resolveAgentOnBindings(id, { "turn-end": "session:a" })
        expect.unreachable(`expected agent-id-invalid for ${JSON.stringify(id)}`)
      } catch (err) {
        expect(err).toBeInstanceOf(EventBindingError)
        expect((err as EventBindingError).code).toBe("agent-id-invalid")
      }
    }
  })

  it("accepts an owner-qualified id and a plain id", () => {
    const owner = resolveAgentOnBindings("@owner/agent-name", { "turn-end": "session:a" })
    expect(owner.map(binding => binding.bindingId)).toEqual(["@owner/agent-name/on/turn-end/0"])

    const plain = resolveAgentOnBindings("agent-1", { "turn-end": "session:a" })
    expect(plain.map(binding => binding.bindingId)).toEqual(["agent-1/on/turn-end/0"])
  })
})
