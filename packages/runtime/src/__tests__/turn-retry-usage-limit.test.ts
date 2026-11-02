/**
 * `usage-limit` as a `turnRetry` class: a provider usage cap (OpenCode's free
 * tier is capped per source IP) does not recover with backoff, so a session
 * that opts in goes straight to rotate / fallback instead of re-prompting the
 * same capped model, and a cap with nothing to move to gives up as before.
 * A sandbox (box) session has no live model switch, so the fallback model
 * overlay must use the restart transition there.
 *
 * Hermetic: real registry + event bus with fake adapter sessions.
 */

import { describe, expect, it } from "vitest"
import type { AgentSessionLike, AgentStreamEvent, SessionDescriptor } from "../sessions.js"
import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus, type SessionFallbackEvent, type SessionTurnRetryEvent } from "../session-event-bus.js"
import { createModelCooldowns } from "../model-cooldowns.js"
import { classifyTurnError, createTurnRetryController, decideTurnRetry } from "../turn-retry.js"
import {
  parseTurnRetryPolicy,
  resolveTurnRetryPolicy,
  turnRetryInputSchema,
  TURN_RETRY_DEFAULT_ON,
} from "../turn-retry-policy.js"

const FAST = { baseDelayMs: 5, factor: 1, maxDelayMs: 5 }
const FREE_A = "opencode/glm-5.3-flash-free"
const FREE_B = "opencode/deepseek-v4.1-flash-free"
const FREE_C = "opencode/big-pickle"
/** The exact string the CI reviewer run died on (fleet boxes share one egress IP). */
const CI_USAGE_LIMIT =
  "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const ok: AgentStreamEvent[] = [
  { kind: "text-delta", text: "done\n" },
  { kind: "turn-end", reason: "completed" },
]
const fail = (message: string): AgentStreamEvent[] => [
  { kind: "error", error: { message } },
  { kind: "turn-end", reason: "error" },
]

function scriptedSession(scripts: AgentStreamEvent[][], trace: string[], opts: { liveSwitch: boolean }) {
  const prompts: string[] = []
  let turn = 0
  let model: string | undefined
  const session: AgentSessionLike = {
    sessionId: "scripted",
    async *send(message: unknown) {
      prompts.push(typeof message === "string" ? message : JSON.stringify(message))
      trace.push(`prompt@${model ?? "initial"}`)
      const script = scripts[Math.min(turn, scripts.length - 1)]!
      turn += 1
      for (const evt of script) yield evt
    },
    async cancel() {},
    async close() {},
    // A sandbox proxy exposes no `setModel`, so the registry answers `not-supported`.
    ...(opts.liveSwitch
      ? {
          async setModel(modelId: string) {
            model = modelId
            trace.push(`setModel:${modelId}`)
            return { applied: true, model: modelId }
          },
        }
      : {}),
  }
  return { session, prompts }
}

function harness(opts: {
  scripts: AgentStreamEvent[][]
  turnRetry: Parameters<typeof resolveTurnRetryPolicy>[0]
  remote?: boolean
  restart?: boolean
}) {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const trace: string[] = []
  const notices: string[] = []
  const cooldowns = createModelCooldowns()
  const restarts: Array<{ id: string; overrides: { model?: string } }> = []
  const controller = createTurnRetryController({
    registry: {
      get: registry.get,
      list: registry.list,
      enqueuePrompt: registry.enqueuePrompt,
      patchTurnRetry: registry.patchTurnRetry,
      setModel: registry.setModel,
      interruptSession: registry.interruptSession,
      recordNotice: (id, text) => {
        notices.push(text)
        return registry.recordNotice(id, text)
      },
    },
    sessionEvents,
    cooldowns,
    ...(opts.restart
      ? {
          restartSession: async (prev: SessionDescriptor, overrides: { model?: string }) => {
            restarts.push({ id: prev.id, overrides })
            return prev
          },
        }
      : {}),
    log: () => {},
  })
  const events: SessionTurnRetryEvent[] = []
  const fallbackEvents: SessionFallbackEvent[] = []
  sessionEvents.on("session:turn-retry", ev => events.push(ev))
  sessionEvents.on("session:fallback", ev => fallbackEvents.push(ev))
  const { session, prompts } = scriptedSession(opts.scripts, trace, { liveSwitch: !opts.remote })
  const spawn = () =>
    registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: session,
      adapterSlug: "fake",
      model: FREE_A,
      ...(opts.remote ? { remote: true, sandboxId: "box_1" } : {}),
      turnRetry: resolveTurnRetryPolicy(opts.turnRetry),
    })
  return {
    registry,
    cooldowns,
    events,
    fallbackEvents,
    notices,
    trace,
    prompts,
    restarts,
    spawn,
    phases: () => events.map(e => e.phase),
    done: () => {
      controller.dispose()
      registry.shutdown()
    },
  }
}

describe("usage-limit turnRetry class: policy and decision", () => {
  it("classifies the exact CI usage-cap string", () => {
    expect(classifyTurnError(CI_USAGE_LIMIT)).toBe("usage-limit")
  })

  it("accepts usage-limit in `on` / `rotateOn` and keeps it out of the default and `all` sets", () => {
    expect(turnRetryInputSchema.safeParse({ on: ["usage-limit"], rotateOn: ["usage-limit"] }).success).toBe(true)
    expect(TURN_RETRY_DEFAULT_ON).not.toContain("usage-limit")
    expect(parseTurnRetryPolicy("all")?.on).not.toContain("usage-limit")
    expect(parseTurnRetryPolicy("usage-limit")?.on).toEqual(["usage-limit"])
  })

  it("rotates on usage-limit by default once the class is opted into `on`", () => {
    const withClass = resolveTurnRetryPolicy({ on: ["usage-limit"], rotate: [{ model: FREE_B }] })
    expect(withClass.rotateOn).toContain("usage-limit")
    const without = resolveTurnRetryPolicy({ on: ["rate-limit"], rotate: [{ model: FREE_B }] })
    expect(without.rotateOn).not.toContain("usage-limit")
  })

  it("decides `divert` (no backoff) for an opted-in usage cap and still skips otherwise", () => {
    const row = (on: Array<"usage-limit" | "rate-limit">) =>
      ({
        id: "s1",
        kind: "agent-cli",
        status: "running",
        turnRetry: resolveTurnRetryPolicy({ on, ...FAST }),
      }) as SessionDescriptor
    const trigger = { kind: "turn-end", reason: "error", error: CI_USAGE_LIMIT } as const
    expect(decideTurnRetry(row(["usage-limit"]), trigger)).toMatchObject({
      action: "divert",
      errorClass: "usage-limit",
      attempt: 1,
    })
    expect(decideTurnRetry(row(["rate-limit"]), trigger)).toMatchObject({ action: "skip", errorClass: "usage-limit" })
  })

  it("holds an opted-in usage cap to the side-effecting tool-call gate", () => {
    const row = (extra: Parameters<typeof resolveTurnRetryPolicy>[0] extends infer T ? Partial<T> : never = {}) =>
      ({
        id: "s1",
        kind: "agent-cli",
        status: "running",
        turnRetry: resolveTurnRetryPolicy({ on: ["usage-limit"], ...FAST, ...extra }),
      }) as SessionDescriptor
    const after = (toolCalls: string[]) =>
      ({ kind: "turn-end", reason: "error", error: CI_USAGE_LIMIT, toolCalls }) as const

    expect(decideTurnRetry(row(), after(["bash"]))).toMatchObject({
      action: "skip",
      errorClass: "usage-limit",
      toolCallsBlocked: true,
    })
    expect(decideTurnRetry(row(), after(["read", "grep"]))).toMatchObject({ action: "divert" })
    expect(decideTurnRetry(row({ retryAfterToolCalls: true }), after(["bash"]))).toMatchObject({ action: "divert" })
    // Without the opt-in the skip is the plain cap skip, which keeps the AIP-46 fallback walk.
    const optedOut = { ...row(), turnRetry: resolveTurnRetryPolicy({ on: ["rate-limit"], ...FAST }) } as SessionDescriptor
    const plain = decideTurnRetry(optedOut, after(["bash"]))
    expect(plain).toMatchObject({ action: "skip", errorClass: "usage-limit" })
    expect(plain).not.toHaveProperty("toolCallsBlocked")
  })
})

describe("usage-limit turnRetry class: controller", () => {
  it("rotates to the next model with no backoff retry and cools the capped model down", async () => {
    const h = harness({
      scripts: [fail(CI_USAGE_LIMIT), ok],
      turnRetry: { on: ["usage-limit"], rotate: [{ model: FREE_B }, { model: FREE_C }], ...FAST },
    })
    const desc = h.spawn()
    await h.registry.sendPrompt(desc.id, "go")
    await until(() => h.prompts.length === 2 && h.registry.get(desc.id)?.busy === false, "rotated continuation")

    expect(h.phases()).not.toContain("scheduled")
    expect(h.phases()).toEqual(["rotated", "sent"])
    expect(h.events[0]).toMatchObject({ errorClass: "usage-limit", fromModel: FREE_A, toModel: FREE_B })
    expect(h.trace).toEqual(["prompt@initial", `setModel:${FREE_B}`, `prompt@${FREE_B}`])
    expect(h.registry.get(desc.id)?.model).toBe(FREE_B)
    expect(h.cooldowns.isCooling(FREE_A)).toBe(true)
    h.done()
  })

  it("falls back to the next overlay with no backoff retry", async () => {
    const h = harness({
      scripts: [fail(CI_USAGE_LIMIT), ok],
      turnRetry: { on: ["usage-limit"], maxRetries: 3, fallback: [{ model: FREE_B }], ...FAST },
    })
    const desc = h.spawn()
    await h.registry.sendPrompt(desc.id, "go")
    await until(() => h.prompts.length === 2 && h.registry.get(desc.id)?.busy === false, "fallback continuation")

    expect(h.phases()).not.toContain("scheduled")
    expect(h.fallbackEvents).toHaveLength(1)
    expect(h.fallbackEvents[0]).toMatchObject({
      transition: "live",
      from: { model: FREE_A },
      to: { model: FREE_B },
      failure: { errorClass: "usage-limit" },
    })
    expect(h.registry.get(desc.id)?.model).toBe(FREE_B)
    h.done()
  })

  it("gives up without re-prompting when no rotate or fallback is configured", async () => {
    const h = harness({
      scripts: [fail(CI_USAGE_LIMIT), ok],
      turnRetry: { on: ["usage-limit"], maxRetries: 3, ...FAST },
    })
    const desc = h.spawn()
    await h.registry.sendPrompt(desc.id, "go")
    await until(() => h.phases().includes("skipped"), "give up")
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(h.prompts).toHaveLength(1)
    expect(h.phases()).toEqual(["skipped"])
    expect(h.registry.get(desc.id)?.turnRetryAttempts).toBeUndefined()
    expect(h.notices.join("\n")).toContain("provider usage cap")
    expect(h.fallbackEvents).toHaveLength(0)
    h.done()
  })

  it("on a sandbox session the fallback model overlay uses the restart transition", async () => {
    const h = harness({
      scripts: [fail(CI_USAGE_LIMIT), ok],
      remote: true,
      restart: true,
      turnRetry: { on: ["usage-limit"], fallback: [{ model: FREE_B }], ...FAST },
    })
    const desc = h.spawn()
    await h.registry.sendPrompt(desc.id, "go")
    await until(() => h.fallbackEvents.length === 1, "box fallback")

    expect(h.fallbackEvents[0]).toMatchObject({ transition: "restart", to: { model: FREE_B } })
    expect(h.restarts).toEqual([{ id: desc.id, overrides: { model: FREE_B } }])
    h.done()
  })

  it("on a sandbox session rotate uses the restart transition instead of giving up", async () => {
    const h = harness({
      scripts: [fail(CI_USAGE_LIMIT), ok],
      remote: true,
      restart: true,
      turnRetry: { on: ["usage-limit"], rotate: [{ model: FREE_B }], ...FAST },
    })
    const desc = h.spawn()
    await h.registry.sendPrompt(desc.id, "go")
    await until(() => h.prompts.length === 2 && h.registry.get(desc.id)?.busy === false, "box rotation")

    expect(h.restarts).toEqual([{ id: desc.id, overrides: { model: FREE_B } }])
    expect(h.phases()).toEqual(["rotated", "sent"])
    expect(h.events[0]).toMatchObject({ errorClass: "usage-limit", fromModel: FREE_A, toModel: FREE_B })
    expect(h.fallbackEvents).toHaveLength(0)
    h.done()
  })

  it("on a sandbox session without a restart hook rotate still falls through to the fallback chain", async () => {
    const h = harness({
      scripts: [fail(CI_USAGE_LIMIT), ok],
      remote: true,
      turnRetry: { on: ["usage-limit"], rotate: [{ model: FREE_B }], ...FAST },
    })
    const desc = h.spawn()
    await h.registry.sendPrompt(desc.id, "go")
    await until(() => h.phases().includes("skipped"), "give up")
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(h.prompts).toHaveLength(1)
    expect(h.phases()).toEqual(["skipped"])
    h.done()
  })

  describe("after a side-effecting tool call", () => {
    const writeThenCap = (toolName: string): AgentStreamEvent[] => [
      { kind: "tool-call", toolCallId: "t1", toolName, arguments: {} } as AgentStreamEvent,
      ...fail(CI_USAGE_LIMIT),
    ]

    it("does not rotate or fall back, and sends no continuation", async () => {
      const h = harness({
        scripts: [writeThenCap("bash"), ok],
        turnRetry: { on: ["usage-limit"], rotate: [{ model: FREE_B }], fallback: [{ model: FREE_C }], ...FAST },
      })
      const desc = h.spawn()
      await h.registry.sendPrompt(desc.id, "go")
      await until(() => h.phases().includes("skipped"), "tool-call gate skip")
      await new Promise(resolve => setTimeout(resolve, 30))

      expect(h.prompts).toHaveLength(1)
      expect(h.trace).toEqual(["prompt@initial"])
      expect(h.phases()).toEqual(["skipped"])
      expect(h.fallbackEvents).toHaveLength(0)
      expect(h.registry.get(desc.id)?.model).toBe(FREE_A)
      expect(h.notices.join("\n")).toContain("retryAfterToolCalls")
      h.done()
    })

    it("a read-only tool call does not trip the gate", async () => {
      const h = harness({
        scripts: [writeThenCap("read"), ok],
        turnRetry: { on: ["usage-limit"], rotate: [{ model: FREE_B }], ...FAST },
      })
      const desc = h.spawn()
      await h.registry.sendPrompt(desc.id, "go")
      await until(() => h.prompts.length === 2 && h.registry.get(desc.id)?.busy === false, "rotated continuation")

      expect(h.registry.get(desc.id)?.model).toBe(FREE_B)
      h.done()
    })

    it("retryAfterToolCalls opts the session back in", async () => {
      const h = harness({
        scripts: [writeThenCap("bash"), ok],
        turnRetry: { on: ["usage-limit"], rotate: [{ model: FREE_B }], retryAfterToolCalls: true, ...FAST },
      })
      const desc = h.spawn()
      await h.registry.sendPrompt(desc.id, "go")
      await until(() => h.prompts.length === 2 && h.registry.get(desc.id)?.busy === false, "rotated continuation")

      expect(h.phases()).toEqual(["rotated", "sent"])
      expect(h.registry.get(desc.id)?.model).toBe(FREE_B)
      h.done()
    })
  })
})
