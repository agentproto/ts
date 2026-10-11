/**
 * Opt-in turn retry (`agent_start.turnRetry`, `turn-retry.ts`): a turn that
 * fails on a transient provider error (429, 5xx, a silent no-output stall) is
 * followed by a short continuation prompt to the SAME live session after
 * backoff — and every "never retry" case stays a plain stop.
 *
 * The integration half drives the real registry + event bus with fake
 * adapter sessions and millisecond backoffs, so it exercises the actual
 * turn-end / stall / interrupt paths in `sessions.ts`, not a mock of them.
 */

import { describe, it, expect } from "vitest"
import {
  createSessionsRegistry,
  NO_OUTPUT_STALL_TURN_ERROR,
  type AgentSessionLike,
  type AgentStreamEvent,
  type SessionDescriptor,
} from "../sessions.js"
import { createSessionEventBus, type SessionTurnRetryEvent } from "../session-event-bus.js"
import {
  buildContinuationPrompt,
  classifyTurnError,
  computeTurnRetryDelayMs,
  createTurnRetryController,
  decideTurnRetry,
  extractRetryAfterMs,
  isReadOnlyToolName,
  NO_OUTPUT_STALL_MARKER,
  TURN_RETRY_PROMPT_SOURCE,
} from "../turn-retry.js"
import { parseTurnRetryPolicy, resolveTurnRetryPolicy, type TurnRetryPolicy } from "../turn-retry-policy.js"

// ── pure halves ──────────────────────────────────────────────────────────

describe("classifyTurnError", () => {
  it.each([
    ["429 status code (no body)", "rate-limit"],
    ["AI_APICallError: Rate limit exceeded for ling-3.1-flash-free", "rate-limit"],
    ["Too Many Requests", "rate-limit"],
    ["RESOURCE_EXHAUSTED: quota", "rate-limit"],
    ["502 Bad Gateway", "upstream-5xx"],
    ["upstream returned status: 503", "upstream-5xx"],
    ['{"type":"error","error":{"type":"overloaded_error"}}', "upstream-5xx"],
    ["Internal server error", "upstream-5xx"],
    ["HTTP 504", "upstream-5xx"],
    [NO_OUTPUT_STALL_MARKER, "no-output-stall"],
    ["401 Unauthorized", "auth"],
    ["status: 403", "auth"],
    ["402 Payment Required", "auth"],
    ["Invalid API key provided", "auth"],
    // Billing reported with a 429 is still billing — not retryable.
    ["429: insufficient_quota — check your plan", "auth"],
    ["Go usage limit exceeded", "usage-limit"],
    ["You've hit your session limit · resets 5pm", "usage-limit"],
    ["context length exceeded: max_tokens 500", "other"],
    ["Internal error: API Error: 400 ...", "other"],
    [undefined, "other"],
  ])("%s → %s", (message, expected) => {
    expect(classifyTurnError(message)).toBe(expected)
  })

  it("the stall marker matches the registry's constant", () => {
    expect(NO_OUTPUT_STALL_MARKER).toBe(NO_OUTPUT_STALL_TURN_ERROR)
  })
})

describe("backoff + hints", () => {
  const policy = resolveTurnRetryPolicy({ on: ["rate-limit"], baseDelayMs: 1000, factor: 2, maxDelayMs: 5000 })
  it("compounds and caps", () => {
    expect([0, 1, 2, 3].map(a => computeTurnRetryDelayMs(policy, a))).toEqual([1000, 2000, 4000, 5000])
  })
  it("raises the delay to a retry-after hint, still capped", () => {
    expect(computeTurnRetryDelayMs(policy, 0, 3000)).toBe(3000)
    expect(computeTurnRetryDelayMs(policy, 0, 60_000)).toBe(5000)
  })
  it.each([
    ["Rate limited. Retry after 30s", 30_000],
    ["retry-after: 12", 12_000],
    ["please try again in 2 minutes", 120_000],
    ["retry in 250ms", 250],
    ["rate limited", undefined],
  ])("extractRetryAfterMs(%s) = %s", (msg, ms) => {
    expect(extractRetryAfterMs(msg)).toBe(ms)
  })
})

describe("parseTurnRetryPolicy", () => {
  it("fills defaults from the shorthand", () => {
    expect(parseTurnRetryPolicy("all")).toEqual({
      on: ["rate-limit", "upstream-5xx", "no-output-stall"],
      maxRetries: 3,
      baseDelayMs: 5000,
      factor: 2,
      maxDelayMs: 60000,
    })
    expect(parseTurnRetryPolicy("rate-limit, upstream-5xx")?.on).toEqual(["rate-limit", "upstream-5xx"])
  })
  it("accepts an object or JSON string", () => {
    expect(parseTurnRetryPolicy('{"on":["rate-limit"],"maxRetries":5,"retryAfterToolCalls":true}')).toMatchObject({
      on: ["rate-limit"],
      maxRetries: 5,
      retryAfterToolCalls: true,
    })
  })
  it("rejects invalid input whole", () => {
    expect(parseTurnRetryPolicy("crashed")).toBeUndefined()
    expect(parseTurnRetryPolicy({ on: [] })).toBeUndefined()
    expect(parseTurnRetryPolicy({ on: ["rate-limit"], maxRetries: -1 })).toBeUndefined()
    expect(parseTurnRetryPolicy("{bad")).toBeUndefined()
  })
})

describe("isReadOnlyToolName", () => {
  it.each([
    ["read", true],
    ["Read File", true],
    ["grep", true],
    ["webfetch", true],
    ["bash", false],
    ["edit", false],
    ["Write /tmp/x", false],
    ["", false],
  ])("%s → %s", (name, ro) => {
    expect(isReadOnlyToolName(name)).toBe(ro)
  })
})

describe("decideTurnRetry", () => {
  const policy: TurnRetryPolicy = resolveTurnRetryPolicy({ on: ["rate-limit", "upstream-5xx", "no-output-stall"] })
  const desc = (over: Partial<SessionDescriptor> = {}): SessionDescriptor =>
    ({ id: "s", kind: "agent-cli", status: "running", turnRetry: policy, ...over }) as SessionDescriptor
  const errEnd = (error: string, extra: object = {}) => ({ kind: "turn-end" as const, reason: "error", error, ...extra })

  it("ignores a session without the policy and a non-error turn-end", () => {
    expect(decideTurnRetry(desc({ turnRetry: undefined }), errEnd("429 status code")).action).toBe("ignore")
    expect(decideTurnRetry(desc(), { kind: "turn-end", reason: "completed" }).action).toBe("ignore")
  })
  it("retries a rate-limit with the first backoff", () => {
    expect(decideTurnRetry(desc(), errEnd("429 status code"))).toMatchObject({
      action: "retry",
      errorClass: "rate-limit",
      attempt: 1,
      delayMs: 5000,
    })
  })
  it("never retries a killed / exited / errored session (kill, cost-cap kill)", () => {
    for (const status of ["killed", "exited", "error"] as const) {
      expect(decideTurnRetry(desc({ status }), errEnd("429 status code"))).toMatchObject({ action: "skip" })
    }
  })
  it("never retries an interrupted turn", () => {
    expect(decideTurnRetry(desc(), errEnd("429 status code", { interrupted: true }))).toMatchObject({
      action: "skip",
      skipReason: "turn was interrupted",
    })
  })
  it("never retries after a governance policy failure (cost budget)", () => {
    expect(decideTurnRetry(desc(), errEnd("429 status code"), { halted: true })).toMatchObject({ action: "skip" })
  })
  it("ignores a stall that is not the no-output stall", () => {
    expect(decideTurnRetry(desc({ lastTurnErrorMessage: "429 status code" }), { kind: "stall" }).action).toBe("ignore")
    expect(decideTurnRetry(desc({ lastTurnErrorMessage: NO_OUTPUT_STALL_MARKER }), { kind: "stall" })).toMatchObject({
      action: "retry",
      errorClass: "no-output-stall",
    })
  })
  it("reports exhaustion once maxRetries consecutive retries were sent", () => {
    expect(decideTurnRetry(desc({ turnRetryAttempts: 3 }), errEnd("503 Service Unavailable"))).toMatchObject({
      action: "exhausted",
      attempts: 3,
    })
  })
})

// ── integration: real registry + controller ──────────────────────────────

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Fake adapter: each turn plays the next script (the last one repeats). A
 *  script is the event list for that turn; `"hang"` waits until cancel(). */
function scriptedSession(scripts: Array<AgentStreamEvent[] | "hang">) {
  const prompts: string[] = []
  let turn = 0
  let release: (() => void) | undefined
  const session: AgentSessionLike = {
    sessionId: "scripted",
    async *send(message: unknown) {
      prompts.push(typeof message === "string" ? message : JSON.stringify(message))
      const script = scripts[Math.min(turn, scripts.length - 1)]!
      turn += 1
      if (script === "hang") {
        await new Promise<void>(resolve => {
          release = resolve
        })
        yield { kind: "turn-end", reason: "cancelled" }
        return
      }
      for (const evt of script) yield evt
    },
    async cancel() {
      release?.()
      release = undefined
    },
    async close() {},
  }
  return { session, prompts }
}

const ok: AgentStreamEvent[] = [
  { kind: "text-delta", text: "done\n" },
  { kind: "turn-end", reason: "completed" },
]
const fail = (message: string, before: AgentStreamEvent[] = []): AgentStreamEvent[] => [
  ...before,
  { kind: "error", error: { message } },
  { kind: "turn-end", reason: "error" },
]
const toolCall = (toolName: string, id: string): AgentStreamEvent[] => [
  { kind: "tool-call", toolCallId: id, toolName, arguments: {} } as AgentStreamEvent,
  { kind: "tool-result", toolCallId: id, result: "ok" } as AgentStreamEvent,
]

const FAST = { baseDelayMs: 5, factor: 1, maxDelayMs: 5 }

function harness(scripts: Array<AgentStreamEvent[] | "hang">, turnRetry?: Parameters<typeof resolveTurnRetryPolicy>[0]) {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const notices: string[] = []
  const controller = createTurnRetryController({
    registry: {
      get: registry.get,
      list: registry.list,
      enqueuePrompt: registry.enqueuePrompt,
      patchTurnRetry: registry.patchTurnRetry,
      recordNotice: (id, text) => {
        notices.push(text)
        return registry.recordNotice(id, text)
      },
    },
    sessionEvents,
    log: () => {},
  })
  const events: SessionTurnRetryEvent[] = []
  sessionEvents.on("session:turn-retry", ev => events.push(ev))
  const { session, prompts } = scriptedSession(scripts)
  const desc = registry.spawnAgent({
    workspaceSlug: "default",
    cwd: "/tmp",
    agentSession: session,
    adapterSlug: "fake",
    ...(turnRetry ? { turnRetry: resolveTurnRetryPolicy(turnRetry) } : {}),
  })
  const phases = () => events.map(e => e.phase)
  const done = () => {
    controller.dispose()
    registry.shutdown()
  }
  return { sessionEvents, registry, controller, events, notices, phases, prompts, desc, done }
}

describe("turn retry — retried classes", () => {
  it.each([
    ["rate-limit", "429 status code (no body)"],
    ["upstream-5xx", "502 Bad Gateway"],
  ] as const)("%s: sends one continuation prompt, counts it, resets on a clean turn", async (cls, message) => {
    const h = harness([fail(message), ok], { on: [cls], ...FAST })
    await h.registry.sendPrompt(h.desc.id, "go")
    await until(() => h.prompts.length === 2 && h.registry.get(h.desc.id)?.busy === false, "continuation turn")

    expect(h.prompts[1]).toContain(buildContinuationPrompt(message))
    expect(h.phases()).toEqual(["scheduled", "sent"])
    expect(h.events[0]).toMatchObject({ errorClass: cls, attempt: 1, maxRetries: 3, delayMs: 5, error: message })
    // The clean continuation turn reset the counter.
    await until(() => h.registry.get(h.desc.id)?.turnRetryAttempts === undefined, "counter reset")
    expect(h.registry.get(h.desc.id)?.nextTurnRetryAt).toBeUndefined()
    h.done()
  })

  it("exposes the retry counter on the descriptor while failures persist, then gives up", async () => {
    const h = harness([fail("429 status code")], { on: ["rate-limit"], maxRetries: 2, ...FAST })
    await h.registry.sendPrompt(h.desc.id, "go")
    await until(() => h.phases().includes("exhausted"), "exhaustion")

    expect(h.prompts).toHaveLength(3) // original + 2 retries
    expect(h.phases()).toEqual(["scheduled", "sent", "scheduled", "sent", "exhausted"])
    expect(h.registry.get(h.desc.id)?.turnRetryAttempts).toBe(2)
    expect(h.registry.get(h.desc.id)?.lastTurnRetryAt).toBeDefined()
    await sleep(20)
    expect(h.prompts).toHaveLength(3)
    h.done()
  })

  it("no-output-stall: interrupts the stuck turn and re-prompts", async () => {
    const h = harness(["hang", ok], { on: ["no-output-stall"], ...FAST })
    const first = h.registry.sendPrompt(h.desc.id, "go")
    await until(() => h.registry.get(h.desc.id)?.busy === true, "turn start")
    expect(h.registry.markStalled(h.desc.id, Date.now())).toBe(true)

    await first
    await until(() => h.prompts.length === 2 && h.registry.get(h.desc.id)?.busy === false, "continuation turn")
    expect(h.prompts[1]).toContain(NO_OUTPUT_STALL_TURN_ERROR)
    expect(h.phases()).toEqual(["scheduled", "sent"])
    expect(h.events[0]?.errorClass).toBe("no-output-stall")
    h.done()
  })

  it("retries a turn that only made read-only tool calls", async () => {
    const h = harness([fail("429 status code", toolCall("read", "t1")), ok], { on: ["rate-limit"], ...FAST })
    await h.registry.sendPrompt(h.desc.id, "go")
    await until(() => h.prompts.length === 2, "continuation")
    h.done()
  })

  it("retryAfterToolCalls opts a side-effecting turn back in", async () => {
    const h = harness([fail("429 status code", toolCall("bash", "t1")), ok], {
      on: ["rate-limit"],
      retryAfterToolCalls: true,
      ...FAST,
    })
    await h.registry.sendPrompt(h.desc.id, "go")
    await until(() => h.prompts.length === 2, "continuation")
    h.done()
  })

  it("records each transition as a transcript notice", async () => {
    const h = harness([fail("429 status code"), ok], { on: ["rate-limit"], ...FAST })
    await h.registry.sendPrompt(h.desc.id, "go")
    await until(() => h.prompts.length === 2, "continuation")
    expect(h.notices).toEqual([
      "[turn-retry] rate-limit: retry 1/3 in 0s",
      "[turn-retry] retry 1/3 (rate-limit) — sending continuation prompt",
    ])
    h.done()
  })
})

describe("turn retry — never retried", () => {
  async function expectNoRetry(
    h: ReturnType<typeof harness>,
    expectedPhases: string[],
  ): Promise<void> {
    await sleep(30)
    expect(h.prompts).toHaveLength(1)
    expect(h.phases()).toEqual(expectedPhases)
    expect(h.registry.get(h.desc.id)?.turnRetryAttempts).toBeUndefined()
    h.done()
  }

  it("off by default: no policy, no event, no prompt", async () => {
    const h = harness([fail("429 status code")])
    await h.registry.sendPrompt(h.desc.id, "go")
    await expectNoRetry(h, [])
  })

  it.each(["401 Unauthorized", "402 Payment Required", "403 Forbidden"])("auth error %s", async message => {
    const h = harness([fail(message)], { on: ["rate-limit", "upstream-5xx", "no-output-stall"], ...FAST })
    await h.registry.sendPrompt(h.desc.id, "go")
    await expectNoRetry(h, ["skipped"])
    expect(h.events[0]?.errorClass).toBe("auth")
  })

  it("a class not listed in `on`", async () => {
    const h = harness([fail("502 Bad Gateway")], { on: ["rate-limit"], ...FAST })
    await h.registry.sendPrompt(h.desc.id, "go")
    await expectNoRetry(h, ["skipped"])
  })

  it("a turn that already made a side-effecting tool call", async () => {
    const h = harness([fail("429 status code", toolCall("bash", "t1"))], { on: ["rate-limit"], ...FAST })
    await h.registry.sendPrompt(h.desc.id, "go")
    await expectNoRetry(h, ["skipped"])
    expect(h.events[0]?.skipReason).toContain("bash")
  })

  it("a user interrupt (turn ends interrupted, even with an error)", async () => {
    // The adapter reports a 429 as its turn is cancelled — still the user's Stop.
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    const controller = createTurnRetryController({ registry, sessionEvents, log: () => {} })
    const phases: string[] = []
    sessionEvents.on("session:turn-retry", ev => phases.push(ev.phase))
    let release!: () => void
    let sends = 0
    const session: AgentSessionLike = {
      sessionId: "interrupted",
      async *send() {
        sends += 1
        await new Promise<void>(r => (release = r))
        yield { kind: "error", error: { message: "429 status code" } }
        yield { kind: "turn-end", reason: "error" }
      },
      async cancel() {
        release()
      },
      async close() {},
    }
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: session,
      adapterSlug: "fake",
      turnRetry: resolveTurnRetryPolicy({ on: ["rate-limit"], ...FAST }),
    })
    const turn = registry.sendPrompt(desc.id, "go")
    await until(() => registry.get(desc.id)?.busy === true, "turn start")
    await registry.interruptSession(desc.id)
    await turn.catch(() => {})
    await sleep(30)
    expect(sends).toBe(1)
    expect(phases).toEqual(["skipped"])
    controller.dispose()
    registry.shutdown()
  })

  it("a kill during the backoff window cancels the pending retry", async () => {
    const h = harness([fail("429 status code")], { on: ["rate-limit"], baseDelayMs: 40, factor: 1, maxDelayMs: 40 })
    await h.registry.sendPrompt(h.desc.id, "go")
    expect(h.controller.pendingIds()).toEqual([h.desc.id])
    expect(h.registry.get(h.desc.id)?.nextTurnRetryAt).toBeDefined()
    await h.registry.kill(h.desc.id)
    await expectNoRetry(h, ["scheduled", "cancelled"])
  })

  it("a user prompt during the backoff window supersedes the retry", async () => {
    const h = harness([fail("429 status code"), ok], { on: ["rate-limit"], baseDelayMs: 40, factor: 1, maxDelayMs: 40 })
    await h.registry.sendPrompt(h.desc.id, "go")
    await h.registry.sendPrompt(h.desc.id, "do something else")
    await sleep(70)
    expect(h.prompts).toHaveLength(2)
    expect(h.prompts[1]).toContain("do something else")
    expect(h.phases()).toEqual(["scheduled", "cancelled"])
    h.done()
  })

  it("a failed governance policy (cost budget) halts retries", async () => {
    const h = harness([fail("429 status code")], { on: ["rate-limit"], baseDelayMs: 40, factor: 1, maxDelayMs: 40 })
    await h.registry.sendPrompt(h.desc.id, "go")
    h.sessionEvents.emit({ type: "policy:failed", policyId: "p1", sessionId: h.desc.id, ts: new Date().toISOString() })
    await sleep(60)
    expect(h.prompts).toHaveLength(1)
    expect(h.phases()).toEqual(["scheduled", "cancelled"])
    h.done()
  })

  it("a stall that recovers before the backoff lands", async () => {
    const h = harness(["hang"], { on: ["no-output-stall"], baseDelayMs: 40, factor: 1, maxDelayMs: 40 })
    const turn = h.registry.sendPrompt(h.desc.id, "go")
    await until(() => h.registry.get(h.desc.id)?.busy === true, "turn start")
    h.registry.markStalled(h.desc.id, Date.now())
    h.registry.clearStalled(h.desc.id)
    await sleep(60)
    expect(h.prompts).toHaveLength(1)
    expect(h.phases()).toEqual(["scheduled", "cancelled"])
    await h.registry.interruptSession(h.desc.id)
    await turn.catch(() => {})
    h.done()
  })
})

// ── admission decides the `sent` transition ─────────────────────────────

/** A controller driven through its narrow structural registry slice, with no
 *  real session behind it: `enqueuePrompt` is whatever the test says, so the
 *  `sent` transition and the attempt booking can be observed directly. */
function stubHarness(opts: {
  enqueuePrompt: (id: string, message: unknown, o?: { interrupt?: boolean; source?: string }) => Promise<unknown>
  row?: Partial<SessionDescriptor>
  turnRetry?: Parameters<typeof resolveTurnRetryPolicy>[0]
}) {
  const sessionEvents = createSessionEventBus()
  const events: SessionTurnRetryEvent[] = []
  sessionEvents.on("session:turn-retry", ev => events.push(ev))
  const notices: string[] = []
  const enqueued: Array<{ message: unknown; opts?: { interrupt?: boolean } }> = []
  const row = {
    id: "s1",
    kind: "agent-cli",
    status: "running",
    turnRetry: resolveTurnRetryPolicy(opts.turnRetry ?? { on: ["rate-limit"], ...FAST }),
    ...opts.row,
  } as SessionDescriptor
  const registry = {
    get: (id: string) => (id === row.id ? row : undefined),
    list: () => [row],
    enqueuePrompt: async (id: string, message: unknown, o?: { interrupt?: boolean; source?: string }) => {
      if (id !== row.id) throw new Error(`no session "${id}"`)
      enqueued.push({ message, ...(o?.interrupt !== undefined ? { opts: { interrupt: o.interrupt } } : {}) })
      return opts.enqueuePrompt(id, message, o)
    },
    recordNotice: (id: string, text: string) => {
      if (id !== row.id) return false
      notices.push(text)
      return true
    },
    patchTurnRetry: (id: string, patch: Record<string, unknown>) => {
      if (id !== row.id) return false
      const r = row as unknown as Record<string, unknown>
      for (const key of ["turnRetryAttempts", "lastTurnRetryAt", "nextTurnRetryAt"] as const) {
        if (!(key in patch)) continue
        const value = patch[key]
        if (value === null || value === undefined) delete r[key]
        else r[key] = value
      }
      return true
    },
  }
  const controller = createTurnRetryController({ registry, sessionEvents, log: () => {} })
  const turnEnd = (error: string) =>
    sessionEvents.emit({
      type: "session:turn-end",
      sessionId: row.id,
      awaitingInput: false,
      reason: "error",
      error,
      ts: new Date().toISOString(),
    })
  return { row, events, notices, enqueued, controller, turnEnd, phases: () => events.map(e => e.phase) }
}

describe("turn retry — admission decides the `sent` transition", () => {
  it("a rejected admission is not `sent`, costs nothing against maxRetries", async () => {
    const h = stubHarness({
      enqueuePrompt: async () => {
        throw new Error("SessionNotAliveError: resume failed — session s1")
      },
      turnRetry: { on: ["rate-limit"], maxRetries: 1, ...FAST },
    })
    h.turnEnd("429 status code")
    await until(() => h.phases().includes("cancelled"), "rejected admission")

    expect(h.enqueued).toHaveLength(1)
    expect(h.phases()).toEqual(["scheduled", "cancelled"])
    expect(h.events[1]).toMatchObject({ phase: "cancelled", attempt: 1, errorClass: "rate-limit" })
    expect(h.events[1]?.skipReason).toContain("continuation prompt rejected")
    // No send notice, only a cancellation one — and the counter untouched.
    expect(h.notices.some(n => n.includes("sending continuation prompt"))).toBe(false)
    expect(h.notices).toContain(
      "[turn-retry] cancelled retry 1: continuation prompt rejected: SessionNotAliveError: resume failed — session s1",
    )
    expect(h.row.turnRetryAttempts).toBeUndefined()
    expect(h.row.lastTurnRetryAt).toBeUndefined()

    // The failed admission did not burn the budget: the next failure still
    // reaches `enqueuePrompt` instead of reporting `exhausted`.
    h.turnEnd("429 status code")
    await until(() => h.phases().length === 4, "the retry budget survived the rejection")
    expect(h.enqueued).toHaveLength(2)
    expect(h.phases()).toEqual(["scheduled", "cancelled", "scheduled", "cancelled"])
    h.controller.dispose()
  })

  it("a successful admission is what marks `sent` and books the attempt", async () => {
    const h = stubHarness({ enqueuePrompt: async () => ({ queued: false, delivery: "delivered" }) })
    h.turnEnd("429 status code")
    await until(() => h.phases().includes("sent"), "sent transition")

    expect(h.enqueued).toHaveLength(1)
    expect(h.phases()).toEqual(["scheduled", "sent"])
    expect(h.notices).toEqual([
      "[turn-retry] rate-limit: retry 1/3 in 0s",
      "[turn-retry] retry 1/3 (rate-limit) — sending continuation prompt",
    ])
    expect(h.row.turnRetryAttempts).toBe(1)
    expect(h.row.lastTurnRetryAt).toBeDefined()
    h.controller.dispose()
  })

  it("a retry that lands while the session moved on writes the `[turn-retry]` notice", async () => {
    // Same guard as a kill during the backoff window, but the timer fires
    // first: another turn is busy by the time the retry is ready.
    const h = stubHarness({ enqueuePrompt: async () => ({}), row: { busy: true, turnsCompleted: 0 } })
    h.turnEnd("429 status code")
    await until(() => h.phases().includes("cancelled"), "stale retry")

    expect(h.enqueued).toHaveLength(0)
    expect(h.phases()).toEqual(["scheduled", "cancelled"])
    expect(h.events[1]?.skipReason).toBe("the session moved on (new turn) before the retry landed")
    expect(h.notices).toContain(
      "[turn-retry] cancelled retry 1: the session moved on (new turn) before the retry landed",
    )
    h.controller.dispose()
  })
})

describe("turn-end event fields the controller relies on", () => {
  it("carries toolCalls and interrupted", async () => {
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    const ends: Array<{ toolCalls?: string[]; interrupted?: boolean }> = []
    sessionEvents.on("session:turn-end", ev => ends.push({ toolCalls: ev.toolCalls, interrupted: ev.interrupted }))
    const { session } = scriptedSession([[...toolCall("bash", "a"), ...toolCall("read", "b"), ...ok], "hang"])
    const desc = registry.spawnAgent({ workspaceSlug: "default", cwd: "/tmp", agentSession: session, adapterSlug: "fake" })
    await registry.sendPrompt(desc.id, "one")
    const second = registry.sendPrompt(desc.id, "two")
    await until(() => registry.get(desc.id)?.busy === true, "second turn")
    await registry.interruptSession(desc.id)
    await second.catch(() => {})
    expect(ends[0]).toEqual({ toolCalls: ["bash", "read"], interrupted: undefined })
    expect(ends[1]).toEqual({ toolCalls: undefined, interrupted: true })
    registry.shutdown()
  })

  it("the continuation prompt carries the daemon provenance", () => {
    expect(TURN_RETRY_PROMPT_SOURCE).toBe("daemon:turn-retry")
  })
})

describe("turnRetry plumbing", () => {
  it("POST /sessions/agent forwards a resolved policy and drops an invalid one", async () => {
    const { buildSpawnSessionHttpArgs } = await import("../http-server.js")
    expect(buildSpawnSessionHttpArgs({ turnRetry: "rate-limit" }, "x").turnRetry).toEqual(
      resolveTurnRetryPolicy({ on: ["rate-limit"] }),
    )
    expect(
      buildSpawnSessionHttpArgs({ turnRetry: { on: ["upstream-5xx"], maxRetries: 1 } }, "x").turnRetry,
    ).toMatchObject({ on: ["upstream-5xx"], maxRetries: 1 })
    expect(buildSpawnSessionHttpArgs({ turnRetry: { on: ["crashed"] } }, "x").turnRetry).toBeUndefined()
    expect(buildSpawnSessionHttpArgs({}, "x").turnRetry).toBeUndefined()
  })

  it("agent_start schema and user presets accept the input shape", async () => {
    const { userPresetSchema } = await import("../user-presets.js")
    expect(userPresetSchema.parse({ id: "free-zen", label: "Free Zen", turnRetry: { on: ["rate-limit"] } }).turnRetry).toEqual({
      on: ["rate-limit"],
    })
    expect(() => userPresetSchema.parse({ id: "x", label: "x", turnRetry: { on: [] } })).toThrow()
  })
})
