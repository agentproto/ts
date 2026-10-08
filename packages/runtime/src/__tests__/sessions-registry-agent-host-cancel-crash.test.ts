/**
 * F44: `workflow_cancel` on a run whose agent step is mid-turn used to crash
 * the whole daemon process.
 *
 * `sendPromptAndWait` created `waitTurnEnd`'s promise BEFORE awaiting
 * `registry.sendPrompt` (which, for an on-host claude-code step, stays
 * pending for the ENTIRE turn). Nobody had attached a `.then`/`.catch` to
 * `waitTurnEnd`'s promise yet — so when `cancel()` -> `releaseAll()` ->
 * `registry.kill()` fired a `session:exited` (`status: "killed"`) WHILE
 * `sendPrompt` was still in flight, that promise rejected with no handler:
 * an unhandled rejection that takes the whole Node process down with it
 * (every other run's sessions included), not just this one step.
 *
 * These tests reproduce the race directly against `SessionsRegistryAgentHost`
 * with a fake registry whose `sendPrompt` never resolves (standing in for a
 * claude-code turn that's still running), fire the kill mid-flight, and
 * assert both that the wait still rejects cleanly (the step must still fail
 * the run) AND that doing so never produces an unhandled rejection.
 */

import { describe, it, expect } from "vitest"
import { createSessionEventBus } from "../session-event-bus.js"
import { SessionsRegistryAgentHost } from "../sessions-registry-agent-host.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import { isAutomatedPromptSource } from "../session-retirement.js"

function makeFakeRegistry(sessionId: string): {
  registry: SessionsRegistry
  sendPromptCalls: Array<{ id: string; prompt: string; source?: string }>
} {
  const sendPromptCalls: Array<{ id: string; prompt: string; source?: string }> = []
  const descriptors = new Map<string, SessionDescriptor>([
    [
      sessionId,
      {
        id: sessionId,
        kind: "agent-cli",
        workspaceSlug: "test",
        command: "mock",
        pid: null,
        status: "running",
        startedAt: new Date().toISOString(),
      },
    ],
  ])
  const registry = {
    get: (id: string) => descriptors.get(id),
    // Stays pending for the whole "turn" — the same shape as a real
    // claude-code `sendPrompt`, which doesn't resolve until the turn ends.
    sendPrompt: (id: string, prompt: string, opts?: { source?: string }) => {
      sendPromptCalls.push({ id, prompt, source: opts?.source })
      return new Promise<void>(() => {})
    },
  } as unknown as SessionsRegistry
  return { registry, sendPromptCalls }
}

const resolveAgentAdapter: AgentAdapterResolver = async () => {
  throw new Error("not used by this test")
}

async function withUnhandledRejectionTracking<T>(run: () => Promise<T>): Promise<{ result: T; unhandled: unknown[] }> {
  const unhandled: unknown[] = []
  const onUnhandledRejection = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on("unhandledRejection", onUnhandledRejection)
  try {
    const result = await run()
    // Give Node's microtask/macrotask queues a chance to surface any
    // unhandled rejection triggered during `run()` before we stop watching.
    await new Promise((r) => setImmediate(r))
    return { result, unhandled }
  } finally {
    process.off("unhandledRejection", onUnhandledRejection)
  }
}

describe("SessionsRegistryAgentHost — cancel-during-turn crash (F44)", () => {
  it("sendPromptAndWait rejects cleanly (no unhandled rejection) when the session is killed mid-turn", async () => {
    const sessionEvents = createSessionEventBus()
    const { registry, sendPromptCalls } = makeFakeRegistry("sess_midturn")
    const host = new SessionsRegistryAgentHost(registry, sessionEvents, resolveAgentAdapter)

    const { result: err, unhandled } = await withUnhandledRejectionTracking(async () => {
      const waitPromise = host.sendPromptAndWait("sess_midturn", "do the thing")
      await new Promise((r) => setImmediate(r))

      // Mirrors `cancel()` -> `releaseAll()` -> `registry.kill()`: the
      // session dies mid-turn, well before `sendPrompt` would ever resolve.
      sessionEvents.emit({
        type: "session:exited",
        sessionId: "sess_midturn",
        status: "killed",
        ts: new Date().toISOString(),
      })

      let caught: unknown
      try {
        await waitPromise
      } catch (e) {
        caught = e
      }
      return caught
    })

    // Workflow steps carry an automated prompt source so they can never
    // revive a retired session.
    expect(sendPromptCalls).toEqual([{ id: "sess_midturn", prompt: "do the thing", source: "workflow:agent-step" }])
    expect(isAutomatedPromptSource(sendPromptCalls[0]!.source)).toBe(true)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/ended with status 'killed'/)
    expect(unhandled).toEqual([])
  })

  it("onAwaitingInput's auto-allow branch also rejects cleanly (no unhandled rejection) when killed mid-turn", async () => {
    const sessionEvents = createSessionEventBus()
    const { registry } = makeFakeRegistry("sess_autoallow")
    const host = new SessionsRegistryAgentHost(registry, sessionEvents, resolveAgentAdapter)
    // `onAwaitingInput` bails out immediately unless the registry reports
    // the session actually awaiting input (checked once, at entry) — model
    // that here, then clear the flag the same way the real registry's
    // `sendPrompt` does before a new turn starts, so `waitTurnEnd`'s own
    // "already terminal" eager-settle check (a SEPARATE, later `get()` call)
    // doesn't short-circuit the wait this test means to exercise.
    let getCalls = 0
    ;(registry as unknown as { get: (id: string) => SessionDescriptor | undefined }).get = (id) => {
      if (id !== "sess_autoallow") return undefined
      getCalls += 1
      return {
        id,
        kind: "agent-cli",
        workspaceSlug: "test",
        command: "mock",
        pid: null,
        status: "running",
        awaitingInput: getCalls === 1,
        startedAt: new Date().toISOString(),
      }
    }

    const { result: err, unhandled } = await withUnhandledRejectionTracking(async () => {
      const waitPromise = host.onAwaitingInput("sess_autoallow", { awaiting: "auto-allow", prompt: "continue" })
      await new Promise((r) => setImmediate(r))

      sessionEvents.emit({
        type: "session:exited",
        sessionId: "sess_autoallow",
        status: "killed",
        ts: new Date().toISOString(),
      })

      let caught: unknown
      try {
        await waitPromise
      } catch (e) {
        caught = e
      }
      return caught
    })

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/ended with status 'killed'/)
    expect(unhandled).toEqual([])
  })
})
