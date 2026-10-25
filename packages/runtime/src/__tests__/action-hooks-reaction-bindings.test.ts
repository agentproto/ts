/**
 * Reaction bindings: the action registry, the one supported host event, the
 * four AIP-41 target arms and the shouldHandle rules, plus one end to end run
 * over the real reaction runner and a real receipt store. No sleeps.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createActionRegistry,
  createReactionReceiptStore,
  createReactionRunner,
  REACTION_EVENT_SUPPORT,
  toReactionBinding,
  ActionRegistryError,
  dispatchResultToOutcome,
  type ActionHandler,
  type ActionRunInput,
  type ReactionBindingDeps,
  type ReactionTargetInput,
} from "../action-hooks/index.js"
import { buildReactionReceiptKey } from "../action-hooks/receipt-store.js"
import {
  createSessionEventBus,
  type SessionCompletedEvent,
  type SessionTurnEndEvent,
} from "../session-event-bus.js"
import type { HookEventRef } from "@agentproto/lifecycle"
import type { ResolvedEventBinding } from "../action-hooks/event-bindings.js"

const EVENT = "agentproto:session-completed"

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "reaction-bindings-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`)
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

async function turn(ms = 50): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms))
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

const hostRef = (event: string): HookEventRef => ({
  raw: event,
  event,
  kind: "host",
  portable: false,
  host: "agentproto",
})

function resolved(over: Partial<ResolvedEventBinding> = {}): ResolvedEventBinding {
  return {
    bindingId: "routine:evt-demo",
    event: hostRef(EVENT),
    target: { tool: "worktree_gc", inputs: { apply: true } },
    source: { kind: "routine", routineId: "evt-demo" },
    configRevision: "0123456789abcdef",
    ...over,
  }
}

function handler(over: Partial<ActionHandler> = {}): ActionHandler {
  return {
    actionId: "session:brain-ingest",
    idempotent: false,
    run: async () => ({ ok: true, outcomeRef: "ok" }),
    ...over,
  }
}

interface Deps {
  deps: ReactionBindingDeps
  dispatchTool: ReturnType<typeof vi.fn>
  getSessionFacts: ReturnType<typeof vi.fn>
}

function makeDeps(over: Partial<ReactionBindingDeps> = {}): Deps {
  const dispatchTool = vi.fn(async (): Promise<unknown> => ({ content: [{ text: "done" }] }))
  const getSessionFacts = vi.fn(() => undefined)
  const deps: ReactionBindingDeps = {
    registry: createActionRegistry(),
    dispatchTool: dispatchTool as unknown as ReactionBindingDeps["dispatchTool"],
    getSessionFacts: getSessionFacts as unknown as ReactionBindingDeps["getSessionFacts"],
    workspaceRoot: "/ws",
    ...over,
  }
  return { deps, dispatchTool, getSessionFacts }
}

const targetInput: ReactionTargetInput = {
  receiptKey: "sess-1/agentproto:session-completed/exit:1/routine:evt-demo",
  sessionId: "sess-1",
  event: EVENT,
  occurrenceId: "exit:1",
  bindingId: "routine:evt-demo",
  reactionDepth: 0,
}

const turnEnd = (): SessionTurnEndEvent => ({
  type: "session:turn-end",
  sessionId: "sess-1",
  awaitingInput: false,
  ts: "2026-01-01T00:00:00.000Z",
})

describe("createActionRegistry", () => {
  it("registers, gets and lists handlers in registration order", () => {
    const first = handler({ actionId: "session:brain-ingest" })
    const second = handler({ actionId: "notify" })
    const registry = createActionRegistry([first, second])

    expect(registry.get("session:brain-ingest")).toBe(first)
    expect(registry.get("notify")).toBe(second)
    expect(registry.list()).toEqual([first, second])

    const third = handler({ actionId: "session:other" })
    registry.register(third)
    expect(registry.list()).toEqual([first, second, third])
  })

  it("accepts a qualified and an unqualified id", () => {
    const registry = createActionRegistry()
    registry.register(handler({ actionId: "session:brain-ingest" }))
    registry.register(handler({ actionId: "notify" }))
    expect(registry.get("session:brain-ingest")?.actionId).toBe("session:brain-ingest")
    expect(registry.get("notify")?.actionId).toBe("notify")
  })

  it("rejects invalid ids with code invalid-id", () => {
    for (const id of ["A:b", "a:", ":b", "a b", ""]) {
      const registry = createActionRegistry()
      try {
        registry.register(handler({ actionId: id }))
        throw new Error(`expected ${JSON.stringify(id)} to be rejected`)
      } catch (err) {
        expect(err).toBeInstanceOf(ActionRegistryError)
        expect((err as ActionRegistryError).code).toBe("invalid-id")
      }
    }
  })

  it("rejects the reserved agentproto category", () => {
    try {
      createActionRegistry().register(handler({ actionId: "agentproto:x" }))
      throw new Error("expected the reserved category to be rejected")
    } catch (err) {
      expect((err as ActionRegistryError).code).toBe("reserved-category")
    }
  })

  it("rejects a duplicate id", () => {
    const registry = createActionRegistry([handler({ actionId: "notify" })])
    try {
      registry.register(handler({ actionId: "notify" }))
      throw new Error("expected the duplicate to be rejected")
    } catch (err) {
      expect((err as ActionRegistryError).code).toBe("duplicate")
    }
  })
})

describe("REACTION_EVENT_SUPPORT", () => {
  it("supports exactly the session-completed event of a real SessionCompletedEvent", () => {
    const event: SessionCompletedEvent = completed()
    expect(REACTION_EVENT_SUPPORT.size).toBe(1)
    expect([...REACTION_EVENT_SUPPORT.keys()]).toEqual([EVENT])
    expect(REACTION_EVENT_SUPPORT.has(event.type)).toBe(true)
  })

  it("occurrenceIdOf returns the occurrence for session-completed and undefined otherwise", () => {
    const support = REACTION_EVENT_SUPPORT.get(EVENT)!
    expect(support.occurrenceIdOf(completed({ occurrenceId: "exit:99" }))).toBe("exit:99")
    expect(support.occurrenceIdOf(turnEnd())).toBeUndefined()
  })

  it("project includes session only when facts exist and carries basis, endedAt and label", () => {
    const support = REACTION_EVENT_SUPPORT.get(EVENT)!
    const facts = { kind: "agent-cli", isChild: false }
    const getSessionFacts = vi.fn(() => facts)

    const projected = support.project(completed({ label: "demo" }), getSessionFacts)!
    expect(projected.basis).toBe("outcome")
    expect(projected.endedAt).toBe("2026-01-01T00:00:00.000Z")
    expect(projected.label).toBe("demo")
    expect(projected.session).toBe(facts)
    expect(getSessionFacts).toHaveBeenCalledWith("sess-1")

    const withoutFacts = support.project(completed(), () => undefined)!
    expect("session" in withoutFacts).toBe(false)
    expect("label" in support.project(completed(), () => facts)!).toBe(false)
  })
})

describe("toReactionBinding", () => {
  it("refuses an unsupported event and names it", () => {
    const { deps } = makeDeps()
    const result = toReactionBinding(
      resolved({ event: { raw: "turn-end", event: "turn-end", kind: "custom", portable: true } }),
      deps,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("turn-end")
      expect(result.error).toContain(EVENT)
    }
  })

  it("refuses an action arm whose id is not registered", () => {
    const { deps } = makeDeps()
    const result = toReactionBinding(resolved({ target: { action: "session:missing" } }), deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("session:missing")
  })

  it("refuses a workflow target that only has a ref", () => {
    const { deps } = makeDeps()
    const result = toReactionBinding(
      resolved({ target: { workflow: { ref: "saved/workflow" } } }),
      deps,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("workflow")
  })

  it("resolves an action arm, forwards the runner input plus authored inputs and mirrors idempotent", async () => {
    const run = vi.fn(async (_input: ActionRunInput) => ({ ok: true, outcomeRef: "action-ok" }))
    const entry = handler({ actionId: "session:brain-ingest", idempotent: true, run })
    const { deps } = makeDeps({ registry: createActionRegistry([entry]) })
    const result = toReactionBinding(
      resolved({ target: { action: "session:brain-ingest", inputs: { mode: "full" } } }),
      deps,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.binding.actionId).toBe("session:brain-ingest")
    expect(result.binding.target.idempotent).toBe(true)

    const outcome = await result.binding.target.run(targetInput)
    expect(outcome).toEqual({ ok: true, outcomeRef: "action-ok" })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[0]).toEqual({ ...targetInput, inputs: { mode: "full" } })
  })

  it("resolves a tool arm and maps an ok result", async () => {
    const { deps, dispatchTool } = makeDeps()
    dispatchTool.mockResolvedValue({ content: [{ text: "  applied  " }], isError: false })
    const result = toReactionBinding(
      resolved({ target: { tool: "worktree_gc", inputs: { apply: true } } }),
      deps,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.binding.actionId).toBe("tool:worktree_gc")
    expect(result.binding.target.idempotent).toBe(false)

    const outcome = await result.binding.target.run(targetInput)
    expect(outcome).toEqual({ ok: true, outcomeRef: "applied" })
    expect(dispatchTool).toHaveBeenCalledTimes(1)
    expect(dispatchTool).toHaveBeenCalledWith("worktree_gc", { apply: true })
  })

  it("maps an isError tool result to a retryable failure with its text", async () => {
    const { deps, dispatchTool } = makeDeps()
    dispatchTool.mockResolvedValue({ content: [{ text: "  boom  " }], isError: true })
    const result = toReactionBinding(resolved(), deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const outcome = await result.binding.target.run(targetInput)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe("boom")
    expect(outcome.retryable).toBeUndefined()
  })

  it("treats a non object tool result as ok", async () => {
    const { deps, dispatchTool } = makeDeps()
    dispatchTool.mockResolvedValue(42)
    const result = toReactionBinding(resolved(), deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(await result.binding.target.run(targetInput)).toEqual({ ok: true, outcomeRef: "ok" })
  })

  it("resolves a workflow arm against the workspace root", async () => {
    const { deps, dispatchTool } = makeDeps({ workspaceRoot: "/ws" })
    const result = toReactionBinding(
      resolved({ target: { workflow: "flows/build.yml", inputs: { x: 1 } } }),
      deps,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.binding.target.idempotent).toBe(false)
    expect(result.binding.actionId).toBe("workflow:run-file")
    await result.binding.target.run(targetInput)
    expect(dispatchTool).toHaveBeenCalledTimes(1)
    expect(dispatchTool).toHaveBeenCalledWith(
      "workflow_run_file",
      expect.objectContaining({ path: "/ws/flows/build.yml", cwd: "/ws" }),
    )
  })

  it("resolves an agent arm with a reaction origin, keeping an author-set origin", async () => {
    const { deps, dispatchTool } = makeDeps()
    const result = toReactionBinding(
      resolved({
        bindingId: "alpha/on/agentproto:session-completed/0",
        target: { agent: { adapter: "claude-code", prompt: "hi" } },
      }),
      deps,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.binding.target.idempotent).toBe(false)
    expect(result.binding.actionId).toBe("agent:start")
    await result.binding.target.run(targetInput)
    expect(dispatchTool).toHaveBeenCalledWith(
      "agent_start",
      expect.objectContaining({ origin: "reaction:alpha/on/agentproto:session-completed/0" }),
    )

    dispatchTool.mockClear()
    const authored = toReactionBinding(
      resolved({
        bindingId: "alpha/on/agentproto:session-completed/1",
        target: { agent: { adapter: "claude-code", prompt: "hi", origin: "custom:origin" } },
      }),
      deps,
    )
    expect(authored.ok).toBe(true)
    if (!authored.ok) return
    await authored.binding.target.run(targetInput)
    expect(dispatchTool).toHaveBeenCalledWith(
      "agent_start",
      expect.objectContaining({ origin: "custom:origin" }),
    )
  })
})

describe("shouldHandle", () => {
  it("returns true without a filter", async () => {
    const { deps } = makeDeps()
    const result = toReactionBinding(resolved(), deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(await result.binding.shouldHandle!(completed())).toBe(true)
  })

  it("evaluates a session filter only when the projected facts match", async () => {
    const matching = makeDeps({
      getSessionFacts: (() => ({ kind: "agent-cli" })) as unknown as ReactionBindingDeps["getSessionFacts"],
    })
    const filter = { "session.kind": "agent-cli" }
    const yes = toReactionBinding(resolved({ filter }), matching.deps)
    expect(yes.ok).toBe(true)
    if (yes.ok) expect(await yes.binding.shouldHandle!(completed())).toBe(true)

    const other = makeDeps({
      getSessionFacts: (() => ({ kind: "agent-acp" })) as unknown as ReactionBindingDeps["getSessionFacts"],
    })
    const no = toReactionBinding(resolved({ filter }), other.deps)
    expect(no.ok).toBe(true)
    if (no.ok) expect(await no.binding.shouldHandle!(completed())).toBe(false)

    const missing = makeDeps()
    const absent = toReactionBinding(resolved({ filter }), missing.deps)
    expect(absent.ok).toBe(true)
    if (absent.ok) expect(await absent.binding.shouldHandle!(completed())).toBe(false)

    if (yes.ok) expect(await yes.binding.shouldHandle!(turnEnd())).toBe(false)
  })

  it("ignores a reaction-launched session for an agent arm", async () => {
    const logs: string[] = []
    const reactionFacts = makeDeps({
      getSessionFacts: (() => ({ origin: "reaction:other" })) as unknown as ReactionBindingDeps["getSessionFacts"],
      log: line => logs.push(line),
    })
    const agentTarget = { agent: { adapter: "claude-code", prompt: "hi" } }
    const agent = toReactionBinding(resolved({ target: agentTarget }), reactionFacts.deps)
    expect(agent.ok).toBe(true)
    if (agent.ok) {
      expect(await agent.binding.shouldHandle!(completed({ sessionId: "s1" }))).toBe(false)
      expect(await agent.binding.shouldHandle!(completed({ sessionId: "s2" }))).toBe(false)
    }
    expect(logs.filter(line => line.includes("ignoring completion of a reaction-launched session"))).toHaveLength(1)

    const routineFacts = makeDeps({
      getSessionFacts: (() => ({ origin: "routine:x" })) as unknown as ReactionBindingDeps["getSessionFacts"],
    })
    const routine = toReactionBinding(resolved({ target: agentTarget }), routineFacts.deps)
    expect(routine.ok).toBe(true)
    if (routine.ok) expect(await routine.binding.shouldHandle!(completed())).toBe(true)

    const noOrigin = makeDeps()
    const noOriginBinding = toReactionBinding(resolved({ target: agentTarget }), noOrigin.deps)
    expect(noOriginBinding.ok).toBe(true)
    if (noOriginBinding.ok) expect(await noOriginBinding.binding.shouldHandle!(completed())).toBe(true)

    const toolBinding = toReactionBinding(resolved(), reactionFacts.deps)
    expect(toolBinding.ok).toBe(true)
    if (toolBinding.ok) {
      expect(await toolBinding.binding.shouldHandle!(completed({ sessionId: "s1" }))).toBe(true)
    }
  })
})

describe("dispatchResultToOutcome", () => {
  it("caps the error text at 500 chars and the outcome text at 200", () => {
    const long = "x".repeat(600)
    const failed = dispatchResultToOutcome({ content: [{ text: long }], isError: true })
    expect(failed.error).toHaveLength(500)
    const ok = dispatchResultToOutcome({ content: [{ text: long }] })
    expect(ok.outcomeRef).toHaveLength(200)
  })
})

describe("end to end with the real runner", () => {
  it("runs one tool arm once per occurrence and records a failed receipt for an error result", async () => {
    const dir = tmp()
    const bus = createSessionEventBus()
    const store = createReactionReceiptStore({ filePath: join(dir, "receipts.json") })
    const dispatchTool = vi.fn(async (): Promise<unknown> => ({ content: [{ text: "applied" }] }))
    const getSessionFacts = vi.fn(() => undefined)
    const result = toReactionBinding(resolved(), {
      registry: createActionRegistry(),
      dispatchTool: dispatchTool as unknown as ReactionBindingDeps["dispatchTool"],
      getSessionFacts: getSessionFacts as unknown as ReactionBindingDeps["getSessionFacts"],
      workspaceRoot: "/ws",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const runner = createReactionRunner({
      bus,
      store,
      bindings: [result.binding],
      retryIntervalMs: 60_000,
    })
    runner.start()

    const event = completed()
    const key = buildReactionReceiptKey({
      sessionId: event.sessionId,
      event: event.type,
      occurrenceId: event.occurrenceId,
      bindingId: result.binding.bindingId,
    })
    bus.emit(event)
    await waitFor(() => store.get(key)?.status === "done")

    expect(dispatchTool).toHaveBeenCalledTimes(1)
    expect(store.get(key)?.status).toBe("done")

    bus.emit(completed())
    await turn()
    expect(dispatchTool).toHaveBeenCalledTimes(1)

    const second = completed({ occurrenceId: "exit:2" })
    dispatchTool.mockResolvedValue({ content: [{ text: "boom" }], isError: true })
    const failedKey = buildReactionReceiptKey({
      sessionId: second.sessionId,
      event: second.type,
      occurrenceId: second.occurrenceId,
      bindingId: result.binding.bindingId,
    })
    bus.emit(second)
    await waitFor(() => store.get(failedKey)?.status === "failed")

    const receipt = store.get(failedKey)
    expect(receipt?.status).toBe("failed")
    expect(receipt?.lastError).toBe("boom")
    runner.stop()
  })
})
