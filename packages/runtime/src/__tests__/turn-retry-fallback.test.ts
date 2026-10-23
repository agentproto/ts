/**
 * `turnRetry.fallback` — after same-config retries are exhausted, an ordered
 * overlay chain is walked forward from `fallbackStep`. Each overlay merges
 * over the BASE (spawn) config and is applied with the least disruptive
 * transition: a model-only change is a live switch, an access (or route)
 * change is a restart, and a harness change is a continue-fresh handoff.
 * Ineligible overlays are skipped, the cursor never moves backwards, and an
 * exhausted chain leaves the session idle instead of looping.
 *
 * Hermetic: real registry + event bus with fake adapter sessions and
 * millisecond backoffs (same approach as turn-retry-rotation.test.ts).
 */

import { describe, expect, it } from "vitest"
import type { AgentSessionLike, AgentStreamEvent, SessionDescriptor } from "../sessions.js"
import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus, type SessionFallbackEvent, type SessionTurnRetryEvent } from "../session-event-bus.js"
import { createModelCooldowns } from "../model-cooldowns.js"
import { createTurnRetryController, type TurnRetryFallbackEffective } from "../turn-retry.js"
import { resolveTurnRetryPolicy } from "../turn-retry-policy.js"
import type { ModelPolicy } from "../model-policy.js"
import { ZERO_COST_LIST_ID } from "../model-list-store.js"

const FAST = { baseDelayMs: 5, factor: 1, maxDelayMs: 5 }
const FREE_A = "opencode/glm-5.3-flash-free"
const FREE_B = "opencode/deepseek-v4.1-flash-free"
const FREE_C = "opencode/big-pickle"

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

function scriptedSession(scripts: AgentStreamEvent[][], trace: string[]) {
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
    async setModel(modelId: string) {
      model = modelId
      trace.push(`setModel:${modelId}`)
      return { applied: true, model: modelId }
    },
  }
  return { session, prompts }
}

function harness(opts: {
  scripts: AgentStreamEvent[][]
  turnRetry: Parameters<typeof resolveTurnRetryPolicy>[0]
  model?: string
  modelPolicy?: ModelPolicy
  cooldowns?: ReturnType<typeof createModelCooldowns>
  isHarnessInstalled?: (harness: string) => Promise<boolean>
  getAuthProfile?: (id: string) => Promise<{ disabled?: boolean } | undefined>
  checkFallbackTarget?: (
    desc: SessionDescriptor,
    target: TurnRetryFallbackEffective,
  ) => Promise<string | undefined>
}) {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const trace: string[] = []
  const notices: string[] = []
  const cooldowns = opts.cooldowns ?? createModelCooldowns()
  const restarts: Array<{ id: string; overrides: { model?: string; access?: { profileRef: string } } }> = []
  const handoffs: Array<{ id: string; opts: { harness: string; model?: string; access?: { profileRef: string } } }> = []
  let freshPrompts: string[] = []

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
    ...(opts.isHarnessInstalled ? { isHarnessInstalled: opts.isHarnessInstalled } : {}),
    ...(opts.getAuthProfile ? { getAuthProfile: opts.getAuthProfile } : {}),
    ...(opts.checkFallbackTarget ? { checkFallbackTarget: opts.checkFallbackTarget } : {}),
    restartSession: async (prev, overrides) => {
      restarts.push({ id: prev.id, overrides })
      return prev
    },
    handoffSession: async (prev, handoffOpts) => {
      handoffs.push({ id: prev.id, opts: handoffOpts })
      const fresh = scriptedSession([ok], trace)
      freshPrompts = fresh.prompts
      const desc = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: fresh.session,
        adapterSlug: handoffOpts.harness,
        harness: handoffOpts.harness,
        ...(handoffOpts.model ? { model: handoffOpts.model } : {}),
      })
      return desc
    },
    log: () => {},
  })

  const events: SessionTurnRetryEvent[] = []
  const fallbackEvents: SessionFallbackEvent[] = []
  sessionEvents.on("session:turn-retry", ev => events.push(ev))
  sessionEvents.on("session:fallback", ev => fallbackEvents.push(ev))

  const { session, prompts } = scriptedSession(opts.scripts, trace)
  const spawn = () =>
    registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: session,
      adapterSlug: "fake",
      model: opts.model ?? FREE_A,
      ...(opts.modelPolicy ? { modelPolicy: opts.modelPolicy } : {}),
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
    handoffs,
    freshPrompts,
    focusPrompts: () => freshPrompts,
    spawn,
    phases: () => events.map(e => e.phase),
    done: () => {
      controller.dispose()
      registry.shutdown()
    },
  }
}

describe("turn retry fallback", () => {
  it("model-only overlay: live switch after retries are exhausted", async () => {
    const h = harness({
      scripts: [fail("429 status code"), fail("429 status code"), ok],
      turnRetry: { on: ["rate-limit"], maxRetries: 1, fallback: [{ model: FREE_B }], ...FAST },
    })
    const desc = h.spawn()
    await h.registry.sendPrompt(desc.id, "go")
    await until(() => h.prompts.length === 3 && h.registry.get(desc.id)?.busy === false, "fallback turn")

    expect(h.trace.filter(t => t.startsWith("setModel"))).toEqual([`setModel:${FREE_B}`])
    expect(h.trace.at(-1)).toBe(`prompt@${FREE_B}`)
    expect(h.registry.get(desc.id)?.model).toBe(FREE_B)
    expect(h.registry.get(desc.id)?.fallbackStep).toBe(0)
    expect(h.fallbackEvents).toHaveLength(1)
    expect(h.fallbackEvents[0]).toMatchObject({
      transition: "live",
      from: { model: FREE_A },
      to: { model: FREE_B },
      failure: { errorClass: "rate-limit" },
    })
    expect(h.phases()).not.toContain("exhausted")
    h.done()
  })

  it("access overlay: restarts with the profile override", async () => {
    const h = harness({
      scripts: [fail("429 status code"), fail("429 status code"), ok],
      turnRetry: {
        on: ["rate-limit"],
        maxRetries: 1,
        fallback: [{ access: { profileRef: "alt" } }],
        ...FAST,
      },
    })
    const desc = h.spawn()
    await h.registry.sendPrompt(desc.id, "go")
    await until(() => h.prompts.length === 3, "fallback turn")

    expect(h.restarts).toHaveLength(1)
    expect(h.restarts[0]).toMatchObject({ id: desc.id, overrides: { access: { profileRef: "alt" } } })
    expect(h.fallbackEvents[0]).toMatchObject({
      transition: "restart",
      from: {},
      to: { accessProfileRef: "alt" },
    })
    expect(h.registry.get(desc.id)?.fallbackStep).toBe(0)
    h.done()
  })

  it("harness overlay: hands the session off and prompts the successor", async () => {
    const h = harness({
      scripts: [fail("429 status code"), fail("429 status code")],
      turnRetry: {
        on: ["rate-limit"],
        maxRetries: 1,
        fallback: [{ harness: "other", model: FREE_C }],
        ...FAST,
      },
    })
    const desc = h.spawn()
    await h.registry.sendPrompt(desc.id, "go")
    await Promise.resolve()
    await until(() => h.fallbackEvents.length === 1, "handoff event")
    await until(() => h.focusPrompts().length === 1, "handoff prompt")

    expect(h.handoffs).toHaveLength(1)
    expect(h.handoffs[0]).toMatchObject({
      id: desc.id,
      opts: { harness: "other", model: FREE_C },
    })
    const event = h.fallbackEvents[0]!
    expect(event).toMatchObject({
      transition: "handoff",
      from: { harness: "fake", model: FREE_A },
      to: { harness: "other", model: FREE_C },
    })
    expect(event.newSessionId).toBeDefined()
    expect(h.registry.get(event.newSessionId!)?.fallbackStep).toBe(0)
    expect(h.registry.get(desc.id)?.fallbackStep).toBeUndefined()
    h.done()
  })

  it("skips an overlay whose harness is not installed", async () => {
    const h = harness({
      scripts: [fail("429 status code"), fail("429 status code"), ok],
      isHarnessInstalled: async harness => harness !== "missing",
      turnRetry: {
        on: ["rate-limit"],
        maxRetries: 1,
        fallback: [{ harness: "missing" }, { model: FREE_B }],
        ...FAST,
      },
    })
    const desc = h.spawn()
    await h.registry.sendPrompt(desc.id, "go")
    await until(() => h.prompts.length === 3, "fallback turn")

    expect(h.handoffs).toHaveLength(0)
    expect(h.registry.get(desc.id)?.model).toBe(FREE_B)
    expect(h.fallbackEvents[0]).toMatchObject({ transition: "live", to: { model: FREE_B } })
    expect(h.notices.join("\n")).toContain('harness "missing" is not installed')
    h.done()
  })

  it("skips an overlay refused by the session model policy", async () => {
    const h = harness({
      scripts: [fail("429 status code"), fail("429 status code"), ok],
      modelPolicy: { allow: [ZERO_COST_LIST_ID] },
      turnRetry: {
        on: ["rate-limit"],
        maxRetries: 1,
        fallback: [{ model: "opencode/gpt-5.1-codex" }, { model: FREE_B }],
        ...FAST,
      },
    })
    const desc = h.spawn()
    await h.registry.sendPrompt(desc.id, "go")
    await until(() => h.prompts.length === 3, "fallback turn")

    expect(h.trace).not.toContain("setModel:opencode/gpt-5.1-codex")
    expect(h.registry.get(desc.id)?.model).toBe(FREE_B)
    expect(h.fallbackEvents[0]).toMatchObject({ transition: "live", to: { model: FREE_B } })
    expect(h.notices.join("\n")).toContain("policy:")
    h.done()
  })

  it("moves the cursor forward only across two failures", async () => {
    const h = harness({
      scripts: [fail("429 status code"), fail("429 status code"), fail("429 status code"), ok],
      turnRetry: {
        on: ["rate-limit"],
        maxRetries: 1,
        fallback: [{ model: FREE_B }, { model: FREE_C }],
        ...FAST,
      },
    })
    const desc = h.spawn()
    await h.registry.sendPrompt(desc.id, "go")
    await until(
      () => h.prompts.length === 4 && h.registry.get(desc.id)?.busy === false,
      "second fallback",
    )

    expect(h.trace.filter(t => t.startsWith("setModel"))).toEqual([
      `setModel:${FREE_B}`,
      `setModel:${FREE_C}`,
    ])
    expect(h.fallbackEvents.map(e => e.to.model)).toEqual([FREE_B, FREE_C])
    expect(h.registry.get(desc.id)?.fallbackStep).toBe(1)
    h.done()
  })

  it("an exhausted chain does not loop", async () => {
    const h = harness({
      scripts: [fail("429 status code")],
      turnRetry: {
        on: ["rate-limit"],
        maxRetries: 1,
        fallback: [{ model: FREE_B }],
        ...FAST,
      },
    })
    const desc = h.spawn()
    await h.registry.sendPrompt(desc.id, "go")
    await until(() => h.phases().includes("exhausted"), "exhaustion")

    expect(h.prompts).toHaveLength(3)
    expect(h.fallbackEvents).toHaveLength(1)
    expect(h.registry.get(desc.id)?.fallbackStep).toBe(0)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.prompts).toHaveLength(3)
    h.done()
  })

  it("a non-classified failure does not trigger a fallback", async () => {
    const h = harness({
      scripts: [
        fail("tool exploded"),
        fail("429 status code"),
        fail("429 status code"),
        ok,
      ],
      turnRetry: {
        on: ["rate-limit"],
        maxRetries: 1,
        fallback: [{ model: FREE_B }],
        ...FAST,
      },
    })
    const desc = h.spawn()
    await h.registry.sendPrompt(desc.id, "go")
    await until(() => h.phases().includes("skipped"), "skip")

    // The tool error is not a FailureClass: no fallback, no model switch.
    expect(h.prompts).toHaveLength(1)
    expect(h.fallbackEvents).toHaveLength(0)
    expect(h.trace.some(t => t.startsWith("setModel"))).toBe(false)
    expect(h.registry.get(desc.id)?.fallbackStep).toBeUndefined()

    // A later CLASSIFIED failure still reaches the chain, proving the test
    // exercises the fallback path rather than passing vacuously.
    await h.registry.sendPrompt(desc.id, "go again")
    await until(() => h.prompts.length === 4 && h.fallbackEvents.length === 1, "classified fallback")
    expect(h.trace).toContain(`setModel:${FREE_B}`)
    expect(h.registry.get(desc.id)?.fallbackStep).toBe(0)
    h.done()
  })
})
