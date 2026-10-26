/**
 * The opt-in clerk reaction: per-firing ownership, the host event, causation,
 * trigger validity, single flight and the registered action. No real clerk
 * controller here; the end to end file covers that.
 */

import { describe, expect, it, vi } from "vitest"

import type { ClerkHookConfig } from "@agentproto/clerk"
import type { SessionClerkDueEvent, SessionEvent } from "../session-event-bus.js"
import type { SessionDescriptor } from "../sessions.js"
import type { ReactionReceipt } from "../action-hooks/receipt-store.js"
import { createActionRegistry } from "../action-hooks/reaction-bindings.js"
import {
  CLERK_REACTION_ACTION_ID,
  CLERK_REACTION_BINDING_ID,
  createClerkReaction,
} from "../action-hooks/clerk-reaction.js"

const ISO = "2026-01-01T00:00:00.000Z"

function clerkConfig(over: Partial<ClerkHookConfig> = {}): ClerkHookConfig {
  return {
    enabled: true,
    on: "turn_end",
    debounceMs: 0,
    run: { routine: "steward" },
    ...over,
  }
}

function descriptor(over: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "sess-1",
    kind: "agent-cli",
    workspaceSlug: "ws-a",
    command: "agent",
    pid: 1,
    status: "running",
    startedAt: ISO,
    ...over,
  } as SessionDescriptor
}

function passInput(session = descriptor()) {
  return { sessionId: session.id, session, config: clerkConfig() }
}

const dueEvent = (sessionId = "sess-1"): SessionEvent =>
  ({
    type: "agentproto:clerk-due",
    sessionId,
    occurrenceId: "due:2026-01-01T00:00:00.000Z",
    ts: ISO,
  }) as SessionEvent

const receipt = (sessionId = "sess-1"): ReactionReceipt =>
  ({ sessionId }) as ReactionReceipt

function harness(
  opts: {
    session?: SessionDescriptor | undefined
    config?: ClerkHookConfig | undefined
    owned?: string[] | (() => Promise<readonly string[]>)
    runPass?: (input: unknown) => Promise<unknown> | unknown
  } = {},
) {
  const sessions = new Map<string, SessionDescriptor>()
  const session = "session" in opts ? opts.session : descriptor()
  if (session) sessions.set(session.id, session)
  const emitted: SessionClerkDueEvent[] = []
  const logs: string[] = []
  const runPass = vi.fn(opts.runPass ?? (async () => ({ ok: true })))
  const owned =
    typeof opts.owned === "function"
      ? opts.owned
      : () => (opts.owned ?? ["ws-a"])
  const reaction = createClerkReaction({
    sessions: { get: id => sessions.get(id) },
    resolveConfig: () => ("config" in opts ? opts.config : clerkConfig()),
    runPass,
    ownedWorkspaces: owned,
    emit: event => emitted.push(event),
    nowIso: () => ISO,
    log: line => logs.push(line),
  })
  return { reaction, sessions, emitted, logs, runPass, session }
}

describe("createClerkReaction dispatch", () => {
  it("calls the legacy runner once and emits nothing for a not owned session", async () => {
    const h = harness({ owned: ["ws-b"] })
    await h.reaction.dispatch(passInput())
    expect(h.runPass).toHaveBeenCalledTimes(1)
    expect(h.emitted).toEqual([])
  })

  it("emits exactly one clerk-due event for an owned session and does not run the pass", async () => {
    const h = harness()
    await h.reaction.dispatch(passInput())
    expect(h.runPass).not.toHaveBeenCalled()
    expect(h.emitted).toEqual([
      {
        type: "agentproto:clerk-due",
        sessionId: "sess-1",
        occurrenceId: `due:${ISO}`,
        ts: ISO,
      },
    ])
  })

  it("treats an undefined workspace slug as not owned", async () => {
    const h = harness({
      session: descriptor({ id: "sess-1", workspaceSlug: undefined as unknown as string }),
      owned: ["ws-a"],
    })
    await h.reaction.dispatch(passInput(descriptor({ workspaceSlug: undefined as unknown as string })))
    expect(h.runPass).toHaveBeenCalledTimes(1)
    expect(h.emitted).toEqual([])
  })

  it("treats a throwing ownedWorkspaces as not owned and logs it", async () => {
    const h = harness({
      owned: async () => {
        throw new Error("config exploded")
      },
    })
    await h.reaction.dispatch(passInput())
    expect(h.runPass).toHaveBeenCalledTimes(1)
    expect(h.emitted).toEqual([])
    expect(h.logs.join("\n")).toContain("config exploded")
  })

  it("does not reject dispatch when emit throws", async () => {
    const logs: string[] = []
    const reaction = createClerkReaction({
      sessions: { get: () => descriptor() },
      resolveConfig: () => clerkConfig(),
      runPass: vi.fn(),
      ownedWorkspaces: () => ["ws-a"],
      emit: () => {
        throw new Error("bus exploded")
      },
      nowIso: () => ISO,
      log: line => logs.push(line),
    })
    await expect(reaction.dispatch(passInput())).resolves.toBeUndefined()
    expect(logs.join("\n")).toContain("bus exploded")
  })

  it("propagates a legacy rejection for a not owned session", async () => {
    const h = harness({
      owned: [],
      runPass: async () => {
        throw new Error("legacy failed")
      },
    })
    await expect(h.reaction.dispatch(passInput())).rejects.toThrow("legacy failed")
  })
})

describe("createClerkReaction binding", () => {
  it("stamps ids, non idempotent target and the stable config revision", () => {
    const h = harness()
    expect(h.reaction.binding.bindingId).toBe(CLERK_REACTION_BINDING_ID)
    expect(h.reaction.binding.actionId).toBe(CLERK_REACTION_ACTION_ID)
    expect(h.reaction.binding.event).toBe("agentproto:clerk-due")
    expect(h.reaction.binding.configRevision).toBe("clerk-pass-v1")
    expect(h.reaction.binding.reactionDepth).toBe(0)
    expect(h.reaction.binding.maxAttempts).toBe(3)
    expect(h.reaction.binding.target.idempotent).toBe(false)
    expect(h.reaction.handler.actionId).toBe(CLERK_REACTION_ACTION_ID)
    expect(h.reaction.handler.idempotent).toBe(false)
  })

  it("returns the occurrence id only for the clerk-due event", () => {
    const h = harness()
    expect(h.reaction.binding.occurrenceIdOf(dueEvent())).toBe(
      "due:2026-01-01T00:00:00.000Z",
    )
    const other = { type: "session:exited" } as SessionEvent
    expect(h.reaction.binding.occurrenceIdOf(other)).toBeUndefined()
  })

  it("reads a finite reaction depth and a string cause from the session facts", () => {
    const h = harness({
      session: descriptor({ meta: { reactionDepth: "2", causedByEventId: "cause-1" } }),
    })
    expect(h.reaction.binding.causation!(dueEvent())).toEqual({
      reactionDepth: 2,
      causedByEventId: "cause-1",
    })
  })

  it("returns undefined causation when the session is gone", () => {
    const h = harness({ session: undefined })
    expect(h.reaction.binding.causation!(dueEvent())).toBeUndefined()
  })

  it("treats a malformed depth as 0", () => {
    const h = harness({ session: descriptor({ meta: { reactionDepth: "not-a-number" } }) })
    expect(h.reaction.binding.causation!(dueEvent())).toEqual({ reactionDepth: 0 })
  })

  it("isTriggerValid is false when the session is gone", async () => {
    const h = harness({ session: undefined })
    expect(await h.reaction.binding.isTriggerValid!(receipt())).toBe(false)
  })

  it("isTriggerValid is false when the config is disabled", async () => {
    const h = harness({ config: clerkConfig({ enabled: false }) })
    expect(await h.reaction.binding.isTriggerValid!(receipt())).toBe(false)
  })

  it("isTriggerValid is false when the workspace is no longer owned", async () => {
    const h = harness({ owned: ["ws-b"] })
    expect(await h.reaction.binding.isTriggerValid!(receipt())).toBe(false)
  })

  it("isTriggerValid is true when the session exists, the config is enabled and the workspace is owned", async () => {
    const h = harness()
    expect(await h.reaction.binding.isTriggerValid!(receipt())).toBe(true)
  })
})

describe("createClerkReaction shared run", () => {
  it("skips with skipped:config when the resolved config is disabled", async () => {
    const h = harness({ config: clerkConfig({ enabled: false }) })
    expect(await h.reaction.binding.target.run(receipt())).toEqual({
      ok: true,
      outcomeRef: "skipped:config",
    })
    expect(h.runPass).not.toHaveBeenCalled()
  })

  it("skips with skipped:config when the session is gone", async () => {
    const h = harness({ session: undefined })
    expect(await h.reaction.binding.target.run(receipt())).toEqual({
      ok: true,
      outcomeRef: "skipped:config",
    })
  })

  it("returns skipped:single_flight for a second concurrent run and calls the pass once", async () => {
    let release!: (value: unknown) => void
    const gate = new Promise(resolve => {
      release = resolve
    })
    const h = harness({ runPass: () => gate })
    const first = h.reaction.binding.target.run(receipt())
    const second = await h.reaction.binding.target.run(receipt())
    expect(second).toEqual({ ok: true, outcomeRef: "skipped:single_flight" })
    expect(h.runPass).toHaveBeenCalledTimes(1)
    release(undefined)
    await first
  })

  it("rejects a throwing pass and releases the single flight for a later run", async () => {
    const h = harness({
      runPass: vi
        .fn()
        .mockRejectedValueOnce(new Error("pass exploded"))
        .mockResolvedValueOnce(undefined),
    })
    await expect(h.reaction.binding.target.run(receipt())).rejects.toThrow("pass exploded")
    expect(await h.reaction.binding.target.run(receipt())).toEqual({
      ok: true,
      outcomeRef: "routine:steward",
    })
    expect(h.runPass).toHaveBeenCalledTimes(2)
  })

  it("reports routine:<id> for a routine arm", async () => {
    const h = harness({ config: clerkConfig({ run: { routine: "steward" } }) })
    expect(await h.reaction.binding.target.run(receipt())).toEqual({
      ok: true,
      outcomeRef: "routine:steward",
    })
  })

  it("reports command:<basename> for a command arm", async () => {
    const h = harness({ config: clerkConfig({ run: { command: "/usr/local/bin/steward" } }) })
    expect(await h.reaction.binding.target.run(receipt())).toEqual({
      ok: true,
      outcomeRef: "command:steward",
    })
  })

  it("handler.run and binding.target.run behave the same", async () => {
    const h = harness()
    const input = { ...receipt(), event: "agentproto:clerk-due", occurrenceId: "due:x", bindingId: CLERK_REACTION_BINDING_ID, reactionDepth: 0 }
    const fromHandler = await h.reaction.handler.run(input)
    const fromTarget = await h.reaction.binding.target.run(receipt())
    expect(fromHandler).toEqual({ ok: true, outcomeRef: "routine:steward" })
    expect(fromTarget).toEqual(fromHandler)
    expect(h.runPass).toHaveBeenCalledTimes(2)
  })

  it("registers the handler in a fresh action registry", () => {
    const h = harness()
    const registry = createActionRegistry()
    registry.register(h.reaction.handler)
    expect(registry.get(CLERK_REACTION_ACTION_ID)).toBe(h.reaction.handler)
  })
})
