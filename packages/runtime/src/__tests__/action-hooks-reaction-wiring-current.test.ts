/**
 * ReactionWiring.current(): the builtin set before any refresh, refusals after
 * a refresh, and defensive copies of both arrays.
 */

import { describe, expect, it, vi } from "vitest"

import {
  createActionRegistry,
  createReactionWiring,
  type ReactionBinding,
  type ResolvedEventBinding,
} from "../action-hooks/index.js"

const EVENT = "agentproto:session-completed"

function builtinBinding(bindingId = "builtin:test"): ReactionBinding {
  return {
    bindingId,
    event: EVENT,
    actionId: "session:test",
    configRevision: "builtin-v1",
    maxAttempts: 3,
    reactionDepth: 0,
    occurrenceIdOf: () => "exit:1",
    target: { actionId: "session:test", idempotent: true, run: async () => ({ ok: true }) },
  }
}

function resolved(over: Partial<ResolvedEventBinding> = {}): ResolvedEventBinding {
  return {
    bindingId: "routine:notify",
    event: { raw: EVENT, event: EVENT, kind: "host", portable: false, host: "agentproto" },
    target: { tool: "notify", inputs: { message: "hi" } },
    source: { kind: "routine", routineId: "notify" },
    configRevision: "cfg-1",
    ...over,
  }
}

describe("reaction wiring current", () => {
  it("returns the builtin set before refresh, refusals after, and copies both arrays", () => {
    const wiring = createReactionWiring({
      runner: { replaceBindings: vi.fn() },
      builtin: [builtinBinding()],
      eventBindings: () => [resolved({ target: { action: "unregistered:act" } })],
      conversion: {
        registry: createActionRegistry(),
        dispatchTool: vi.fn(async () => ({ content: [{ text: "ok" }] })),
        getSessionFacts: () => ({ kind: "agent-cli" }),
        workspaceRoot: "/tmp",
      },
      log: () => {},
    })

    const before = wiring.current()
    expect(before).toEqual({ active: ["builtin:test"], refused: [] })
    before.active.push("mutated")
    expect(wiring.current().active).toEqual(["builtin:test"])

    wiring.refresh()
    const after = wiring.current()
    expect(after.active).toEqual(["builtin:test"])
    expect(after.refused).toEqual([
      {
        bindingId: "routine:notify",
        error: "action 'unregistered:act' is not registered; a binding may not reference an unknown action",
      },
    ])
    after.active.push("mutated")
    after.refused[0]?.error && (after.refused[0].error = "mutated")
    after.refused.push({ bindingId: "mutated", error: "mutated" })
    expect(wiring.current()).toEqual({
      active: ["builtin:test"],
      refused: [
        {
          bindingId: "routine:notify",
          error: "action 'unregistered:act' is not registered; a binding may not reference an unknown action",
        },
      ],
    })
  })
})
