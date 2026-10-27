import { describe, expect, it, vi } from "vitest"

import type { HookEventRef } from "@agentproto/lifecycle"
import {
  createActionRegistry,
  createReactionWiring,
  sessionFactsOf,
  toReactionBinding,
  type ActionHandler,
  type ReactionBindingDeps,
  type ResolvedEventBinding,
} from "../action-hooks/index.js"
import type { AgentOnScanResult } from "../action-hooks/agent-on-scanner.js"
import type { SessionCompletedEvent } from "../session-event-bus.js"
import type { SessionDescriptor } from "../sessions.js"

const EVENT = "agentproto:session-completed"

const hostRef = (event: string): HookEventRef => ({
  raw: event,
  event,
  kind: "host",
  portable: false,
  host: "agentproto",
})

const completed = (sessionId: string): SessionCompletedEvent => ({
  type: EVENT,
  sessionId,
  occurrenceId: `exit:${sessionId}`,
  basis: "outcome",
  endedAt: "2026-01-01T00:00:00.000Z",
  ts: "2026-01-01T00:00:00.000Z",
})

function agentOnBinding(agentId: string, bindingId = `${agentId}/on/${EVENT}/0`): ResolvedEventBinding {
  return {
    bindingId,
    event: hostRef(EVENT),
    target: { action: "demo:note" },
    source: { kind: "agent-on", agentId, event: EVENT, index: 0 },
    configRevision: "0123456789abcdef",
  }
}

const noteHandler: ActionHandler = {
  actionId: "demo:note",
  idempotent: false,
  run: async () => ({ ok: true, outcomeRef: "noted" }),
}

function depsWith(getSessionFacts: ReactionBindingDeps["getSessionFacts"], log?: (line: string) => void): ReactionBindingDeps {
  return {
    registry: createActionRegistry([noteHandler]),
    dispatchTool: async () => ({ content: [{ text: "ok" }] }),
    getSessionFacts,
    workspaceRoot: "/ws",
    ...(log ? { log } : {}),
  }
}

function descriptor(meta?: Record<string, string>): SessionDescriptor {
  return {
    kind: "agent-cli",
    ...(meta ? { meta } : {}),
  } as unknown as SessionDescriptor
}

describe("sessionFactsOf agentId", () => {
  it("exposes agentId from meta and omits it otherwise", () => {
    expect(sessionFactsOf(descriptor({ agentId: "archiver" })).agentId).toBe("archiver")
    expect(sessionFactsOf(descriptor({}))).not.toHaveProperty("agentId")
    expect(sessionFactsOf(descriptor({ agentId: "" }))).not.toHaveProperty("agentId")
  })
})

describe("agent-on binding scope", () => {
  it("handles an event whose session declares the same agent id", async () => {
    const resolved = agentOnBinding("archiver")
    const binding = toReactionBinding(
      resolved,
      depsWith(id => (id === "s1" ? sessionFactsOf(descriptor({ agentId: "archiver" })) : undefined)),
    )
    expect(binding.ok).toBe(true)
    if (!binding.ok) return
    await expect(binding.binding.shouldHandle(completed("s1"))).resolves.toBe(true)
  })

  it("does not handle another agent id, a missing agent id, or unreadable facts", async () => {
    const log = vi.fn()
    const facts = new Map<string, Record<string, unknown>>([
      ["other", sessionFactsOf(descriptor({ agentId: "other" }))],
      ["none", sessionFactsOf(descriptor({}))],
    ])
    const binding = toReactionBinding(
      agentOnBinding("archiver"),
      depsWith(id => facts.get(id), log),
    )
    expect(binding.ok).toBe(true)
    if (!binding.ok) return
    await expect(binding.binding.shouldHandle(completed("other"))).resolves.toBe(false)
    await expect(binding.binding.shouldHandle(completed("none"))).resolves.toBe(false)
    await expect(binding.binding.shouldHandle(completed("missing"))).resolves.toBe(false)
    await expect(binding.binding.shouldHandle(completed("missing"))).resolves.toBe(false)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]?.[0]).toContain("cannot read the session facts, not firing")
  })

  it("leaves a routine binding on the same event unaffected by agentId", async () => {
    const resolved: ResolvedEventBinding = {
      bindingId: "routine:evt-demo",
      event: hostRef(EVENT),
      target: { action: "demo:note" },
      source: { kind: "routine", routineId: "evt-demo" },
      configRevision: "0123456789abcdef",
    }
    const binding = toReactionBinding(
      resolved,
      depsWith(() => sessionFactsOf(descriptor({ agentId: "someone-else" }))),
    )
    expect(binding.ok).toBe(true)
    if (!binding.ok) return
    await expect(binding.binding.shouldHandle(completed("s1"))).resolves.toBe(true)
  })
})

describe("reaction wiring agent bindings", () => {
  function routineBinding(): ResolvedEventBinding {
    return {
      bindingId: "routine:evt-demo",
      event: hostRef(EVENT),
      target: { action: "demo:note" },
      source: { kind: "routine", routineId: "evt-demo" },
      configRevision: "0123456789abcdef",
    }
  }

  function wiring(agentBindings?: () => AgentOnScanResult) {
    const replaceBindings = vi.fn()
    return {
      replaceBindings,
      wiring: createReactionWiring({
        runner: { replaceBindings },
        builtin: [],
        eventBindings: () => [routineBinding()],
        ...(agentBindings ? { agentBindings } : {}),
        conversion: depsWith(() => undefined),
        log: () => {},
      }),
    }
  }

  it("places agent bindings after routine bindings", () => {
    const scan = (): AgentOnScanResult => ({ bindings: [agentOnBinding("archiver")], errors: [] })
    const { wiring: w } = wiring(scan)
    expect(w.refresh().active).toEqual([
      "routine:evt-demo",
      `archiver/on/${EVENT}/0`,
    ])
  })

  it("reports scanner errors as refused <agent-id>/on", () => {
    const scan = (): AgentOnScanResult => ({
      bindings: [],
      errors: [{ agentId: "broken", error: "bad on map" }],
    })
    const { wiring: w } = wiring(scan)
    expect(w.refresh().refused).toEqual([{ bindingId: "broken/on", error: "bad on map" }])
  })

  it("refuses a duplicate binding id", () => {
    const duplicate = agentOnBinding("archiver")
    const scan = (): AgentOnScanResult => ({ bindings: [duplicate, duplicate], errors: [] })
    const { wiring: w } = wiring(scan)
    const result = w.refresh()
    expect(result.active).toEqual(["routine:evt-demo", `archiver/on/${EVENT}/0`])
    expect(result.refused).toEqual([
      { bindingId: `archiver/on/${EVENT}/0`, error: `duplicate binding id 'archiver/on/${EVENT}/0'` },
    ])
  })

  it("produces the same active list as before without agentBindings", () => {
    const { wiring: w } = wiring()
    expect(w.refresh().active).toEqual(["routine:evt-demo"])
    expect(w.current().active).toEqual(["routine:evt-demo"])
  })
})
