/**
 * Reaction causation: the runner derives a receipt's depth and caused event id
 * from the triggering event and carries the reaction context into the target.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionEventBus, type SessionCompletedEvent, type SessionEvent } from "../session-event-bus.js"
import {
  buildReactionReceiptKey,
  createActionRegistry,
  createReactionReceiptStore,
  createReactionRunner,
  currentReactionContext,
  toReactionBinding,
  type ReactionBinding,
  type ReactionBindingDeps,
  type ReactionReceiptStore,
  type ReactionTargetInput,
  type ReactionTargetOutcome,
  type ResolvedEventBinding,
} from "../action-hooks/index.js"

const dirs: string[] = []
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "reaction-causation-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const EVENT = "agentproto:session-completed"

const completed = (over: Partial<SessionCompletedEvent> = {}): SessionCompletedEvent => ({
  type: EVENT,
  sessionId: "sess-1",
  occurrenceId: "exit:1",
  basis: "outcome",
  endedAt: "2026-01-01T00:00:00.000Z",
  ts: "2026-01-01T00:00:00.000Z",
  ...over,
})

const keyOf = (occurrenceId = "exit:1", bindingId = "bind-1"): string =>
  buildReactionReceiptKey({ sessionId: "sess-1", event: EVENT, occurrenceId, bindingId })

function openStore(): ReactionReceiptStore {
  return createReactionReceiptStore({
    filePath: join(tmp(), "receipts.json"),
    debounceMs: 60_000,
    log: () => {},
  })
}

function makeBinding(over: Partial<ReactionBinding> = {}): ReactionBinding {
  const run = vi.fn(async (_input: ReactionTargetInput): Promise<ReactionTargetOutcome> => ({ ok: true }))
  return {
    bindingId: "bind-1",
    event: EVENT,
    actionId: "brain:ingest",
    configRevision: "cfg-1",
    maxAttempts: 3,
    reactionDepth: 0,
    occurrenceIdOf: (event: SessionEvent) =>
      event.type === EVENT ? (event as SessionCompletedEvent).occurrenceId : undefined,
    target: { actionId: "brain:ingest", idempotent: true, run },
    ...over,
  }
}

describe("reaction causation", () => {
  it("marks a receipt dead at the cap and never runs the target", async () => {
    const store = openStore()
    const binding = makeBinding({ causation: () => ({ reactionDepth: 4 }) })
    const runner = createReactionRunner({
      bus: createSessionEventBus(),
      store,
      bindings: [binding],
      log: () => {},
    })

    await runner.handleEvent(completed(), "exit:1")

    const receipt = store.get(keyOf())
    expect(receipt).toMatchObject({ status: "dead", lastError: "recursion_cap", reactionDepth: 4 })
    expect(binding.target.run).not.toHaveBeenCalled()
  })

  it("runs below the cap and stores the derived depth and caused event id", async () => {
    const store = openStore()
    const binding = makeBinding({
      causation: () => ({ reactionDepth: 3, causedByEventId: "upstream-receipt" }),
    })
    const runner = createReactionRunner({
      bus: createSessionEventBus(),
      store,
      bindings: [binding],
      log: () => {},
    })

    await runner.handleEvent(completed(), "exit:1")

    const receipt = store.get(keyOf())
    expect(receipt).toMatchObject({
      status: "done",
      reactionDepth: 3,
      causedByEventId: "upstream-receipt",
    })
    expect(binding.target.run).toHaveBeenCalledTimes(1)
  })

  it("logs a throwing causation and falls back to the static depth", async () => {
    const store = openStore()
    const logs: string[] = []
    const binding = makeBinding({
      reactionDepth: 2,
      causation: () => {
        throw new Error("bad facts")
      },
    })
    const runner = createReactionRunner({
      bus: createSessionEventBus(),
      store,
      bindings: [binding],
      log: line => logs.push(line),
    })

    await runner.handleEvent(completed(), "exit:1")

    expect(store.get(keyOf())).toMatchObject({ status: "done", reactionDepth: 2 })
    expect(logs.some(line => line.includes("causation bind-1 failed: bad facts"))).toBe(true)
    expect(binding.target.run).toHaveBeenCalledTimes(1)
  })

  it("runs the target inside the reaction context derived from the receipt", async () => {
    const store = openStore()
    let seen: ReturnType<typeof currentReactionContext>
    const binding = makeBinding({
      causation: () => ({ reactionDepth: 2, causedByEventId: "upstream" }),
      target: {
        actionId: "brain:ingest",
        idempotent: true,
        run: async () => {
          seen = currentReactionContext()
          return { ok: true }
        },
      },
    })
    const runner = createReactionRunner({
      bus: createSessionEventBus(),
      store,
      bindings: [binding],
      log: () => {},
    })

    await runner.handleEvent(completed(), "exit:1")

    expect(seen).toEqual({
      bindingId: "bind-1",
      reactionDepth: 3,
      causedByEventId: keyOf(),
    })
  })

  it("reads causation from the session facts in toReactionBinding", () => {
    const resolved: ResolvedEventBinding = {
      bindingId: "routine:notify",
      event: { raw: EVENT, event: EVENT, kind: "host", portable: false, host: "agentproto" },
      target: { tool: "notify", inputs: { message: "hi" } },
      source: { kind: "routine", routineId: "notify" },
      configRevision: "cfg-1",
    }
    const deps = (facts: Record<string, unknown> | undefined): ReactionBindingDeps => ({
      registry: createActionRegistry(),
      dispatchTool: vi.fn(async () => ({ content: [{ text: "ok" }] })),
      getSessionFacts: () => facts,
      workspaceRoot: "/tmp",
    })
    const event = completed()

    const converted = toReactionBinding(resolved, deps({ reactionDepth: 2, causedByEventId: "cause-1" }))
    if (!converted.ok) throw new Error(converted.error)
    expect(converted.binding.causation?.(event)).toEqual({
      reactionDepth: 2,
      causedByEventId: "cause-1",
    })

    const missing = toReactionBinding(resolved, deps(undefined))
    if (!missing.ok) throw new Error(missing.error)
    expect(missing.binding.causation?.(event)).toBeUndefined()

    const nonFinite = toReactionBinding(resolved, deps({ reactionDepth: Number.NaN }))
    if (!nonFinite.ok) throw new Error(nonFinite.error)
    expect(nonFinite.binding.causation?.(event)).toEqual({ reactionDepth: 0 })
  })
})
