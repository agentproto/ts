/**
 * Reaction wiring: conversion, refusals, hot refresh and session facts.
 */

import { describe, expect, it, vi } from "vitest"

import type { SessionDescriptor } from "../sessions.js"
import {
  createActionRegistry,
  createReactionWiring,
  sessionFactsOf,
  type ReactionBinding,
  type ReactionBindingDeps,
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

function conversion(over: Partial<ReactionBindingDeps> = {}): ReactionBindingDeps {
  return {
    registry: createActionRegistry(),
    dispatchTool: vi.fn(async () => ({ content: [{ text: "ok" }] })),
    getSessionFacts: () => ({ kind: "agent-cli" }),
    workspaceRoot: "/tmp",
    ...over,
  }
}

function wiring(opts: {
  eventBindings: () => readonly ResolvedEventBinding[]
  builtin?: readonly ReactionBinding[]
  conversion?: ReactionBindingDeps
}) {
  const replaceBindings = vi.fn()
  const logs: string[] = []
  const w = createReactionWiring({
    runner: { replaceBindings },
    builtin: opts.builtin ?? [builtinBinding()],
    eventBindings: opts.eventBindings,
    conversion: opts.conversion ?? conversion(),
    log: line => logs.push(line),
  })
  return { w, replaceBindings, logs }
}

describe("reaction wiring", () => {
  it("refresh with builtin only makes the builtin live", () => {
    const { w, replaceBindings } = wiring({ eventBindings: () => [] })
    const result = w.refresh()
    expect(result).toEqual({ active: ["builtin:test"], refused: [] })
    expect(replaceBindings).toHaveBeenCalledTimes(1)
    expect(replaceBindings.mock.calls[0]?.[0].map((binding: ReactionBinding) => binding.bindingId)).toEqual([
      "builtin:test",
    ])
  })

  it("a convertible routine binding goes live after the builtin", () => {
    const { w, replaceBindings } = wiring({ eventBindings: () => [resolved()] })
    const result = w.refresh()
    expect(result.active).toEqual(["builtin:test", "routine:notify"])
    expect(result.refused).toEqual([])
    expect(replaceBindings.mock.calls[0]?.[0].map((binding: ReactionBinding) => binding.actionId)).toEqual([
      "session:test",
      "tool:notify",
    ])
  })

  it("an unconvertible action arm is refused with its error and not live", () => {
    const { w } = wiring({
      eventBindings: () => [resolved({ target: { action: "unregistered:act" } })],
    })
    const result = w.refresh()
    expect(result.active).toEqual(["builtin:test"])
    expect(result.refused).toEqual([
      {
        bindingId: "routine:notify",
        error: "action 'unregistered:act' is not registered; a binding may not reference an unknown action",
      },
    ])
  })

  it("a duplicate of a builtin id is refused and the builtin is kept", () => {
    const { w, replaceBindings } = wiring({
      eventBindings: () => [resolved({ bindingId: "builtin:test", target: { tool: "other" } })],
    })
    const result = w.refresh()
    expect(result.active).toEqual(["builtin:test"])
    expect(result.refused).toEqual([
      { bindingId: "builtin:test", error: "duplicate binding id 'builtin:test'" },
    ])
    expect(replaceBindings.mock.calls[0]?.[0]).toHaveLength(1)
    expect(replaceBindings.mock.calls[0]?.[0][0].actionId).toBe("session:test")
  })

  it("logs the same refusal only once across refreshes", () => {
    const { w, logs } = wiring({
      eventBindings: () => [resolved({ target: { action: "unregistered:act" } })],
    })
    w.refresh()
    w.refresh()
    expect(logs.filter(line => line.includes("unregistered:act"))).toHaveLength(1)
  })

  it("a throwing eventBindings keeps the previous live set and reports *", () => {
    let throwNow = false
    const { w, replaceBindings } = wiring({
      eventBindings: () => {
        if (throwNow) throw new Error("scan exploded")
        return [resolved()]
      },
    })
    const first = w.refresh()
    expect(first.active).toEqual(["builtin:test", "routine:notify"])
    throwNow = true
    const second = w.refresh()
    expect(replaceBindings).toHaveBeenCalledTimes(1)
    expect(second.active).toEqual(["builtin:test", "routine:notify"])
    expect(second.refused).toContainEqual({ bindingId: "*", error: "scan exploded" })
  })
})

describe("sessionFactsOf", () => {
  const base = {
    id: "sess-1",
    kind: "agent-cli",
    workspaceSlug: "demo",
    command: "agent",
    pid: 1,
    status: "exited",
    startedAt: "2026-01-01T00:00:00.000Z",
  } as SessionDescriptor

  it("projects only defined fields and derives isChild from the parent id", () => {
    const top = sessionFactsOf(base)
    expect(top).toEqual({ kind: "agent-cli", isChild: false, workspaceSlug: "demo" })
    expect("origin" in top).toBe(false)
    expect("adapter" in top).toBe(false)
    expect("label" in top).toBe(false)

    const child = sessionFactsOf({
      ...base,
      parentSessionId: "sess-0",
      origin: "cron",
      adapterSlug: "claude-code",
      label: "worker",
    })
    expect(child).toEqual({
      kind: "agent-cli",
      isChild: true,
      workspaceSlug: "demo",
      origin: "cron",
      adapter: "claude-code",
      label: "worker",
    })
  })

  it("omits workspaceSlug when the descriptor has none", () => {
    const facts = sessionFactsOf({
      ...base,
      workspaceSlug: undefined,
    } as unknown as SessionDescriptor)
    expect("workspaceSlug" in facts).toBe(false)
    expect(facts.kind).toBe("agent-cli")
  })
})
