/**
 * `turnRetry.rotate` — on a rate-limit / silent stall the controller switches
 * the live session to the next eligible fallback model BEFORE the continuation
 * prompt, a daemon-wide cooldown map keeps every session off a throttled model,
 * and a free OpenCode session never rotates onto a paid id.
 *
 * Hermetic: real session registry + event bus with fake adapter sessions and
 * millisecond backoffs (same approach as `turn-retry.test.ts`); no network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AuthProfile } from "@agentproto/auth"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
  type SessionDescriptor,
} from "../sessions.js"
import { createSessionEventBus, type SessionTurnRetryEvent } from "../session-event-bus.js"
import { createModelCooldowns } from "../model-cooldowns.js"
import {
  createTurnRetryController,
  rotationTargetRejection,
  type RotationTargetCheck,
} from "../turn-retry.js"
import { createRotationTargetCheck } from "../turn-retry-eligibility.js"
import {
  parseTurnRetryPolicy,
  resolveTurnRetryPolicy,
  validateTurnRetryRotate,
} from "../turn-retry-policy.js"
import { inModelList } from "@agentproto/model-catalog/lists"
import { seedModelListSource, ZERO_COST_LIST_ID } from "../model-list-store.js"
import { spawnAgentSession } from "../session-spawn.js"
import { addHarnessPreset, HarnessPresetValidationError } from "../harness-preset-store.js"
import { saveUserPreset } from "../user-presets.js"
import { registerDaemonHealthTools } from "../daemon-health-tools.js"
import { createMcpServer } from "@agentproto/mcp-server"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"

const FAST = { baseDelayMs: 5, factor: 1, maxDelayMs: 5 }
const FREE_A = "opencode/glm-5.3-flash-free"
const FREE_B = "opencode/deepseek-v4.1-flash-free"
const FREE_C = "opencode/big-pickle"
const PAID = "opencode/gpt-5.1-codex"

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

/** Fake adapter whose `setModel` records the wire ids and whose prompts record
 *  which model was active when each one arrived — so ordering is observable. */
function scriptedSession(scripts: Array<AgentStreamEvent[] | "hang">, trace: string[]) {
  const prompts: string[] = []
  let turn = 0
  let release: (() => void) | undefined
  let model: string | undefined
  const session: AgentSessionLike = {
    sessionId: "scripted",
    async *send(message: unknown) {
      prompts.push(typeof message === "string" ? message : JSON.stringify(message))
      trace.push(`prompt@${model ?? "initial"}`)
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
      trace.push("cancel")
      release?.()
      release = undefined
    },
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
  scripts: Array<AgentStreamEvent[] | "hang">
  model?: string
  turnRetry: Parameters<typeof resolveTurnRetryPolicy>[0]
  cooldowns?: ReturnType<typeof createModelCooldowns>
  check?: RotationTargetCheck
  accessProfile?: SessionDescriptor["accessProfile"]
}) {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const trace: string[] = []
  const notices: string[] = []
  const cooldowns = opts.cooldowns ?? createModelCooldowns()
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
    ...(opts.check ? { checkRotationTarget: opts.check } : {}),
    log: () => {},
  })
  const events: SessionTurnRetryEvent[] = []
  sessionEvents.on("session:turn-retry", ev => events.push(ev))
  const { session, prompts } = scriptedSession(opts.scripts, trace)
  const spawn = () =>
    registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: session,
      adapterSlug: "fake",
      model: opts.model ?? FREE_A,
      ...(opts.accessProfile ? { accessProfile: opts.accessProfile } : {}),
      turnRetry: resolveTurnRetryPolicy(opts.turnRetry),
    })
  const done = () => {
    controller.dispose()
    registry.shutdown()
  }
  return { registry, cooldowns, events, notices, trace, prompts, spawn, done, phases: () => events.map(e => e.phase) }
}

describe("turn retry rotation — runtime", () => {
  it("rate-limit: switches to the next target, THEN sends the continuation", async () => {
    const h = harness({
      scripts: [fail("429 status code"), ok],
      turnRetry: { on: ["rate-limit"], rotate: [{ model: FREE_B }, { model: FREE_C }], ...FAST },
    })
    const desc = h.spawn()
    await h.registry.sendPrompt(desc.id, "go")
    await until(() => h.prompts.length === 2 && h.registry.get(desc.id)?.busy === false, "continuation turn")

    expect(h.trace.filter(t => t !== "cancel")).toEqual([
      "prompt@initial",
      `setModel:${FREE_B}`,
      `prompt@${FREE_B}`,
    ])
    expect(h.registry.get(desc.id)?.model).toBe(FREE_B)
    expect(h.phases()).toEqual(["scheduled", "rotated", "sent"])
    expect(h.events[1]).toMatchObject({
      phase: "rotated",
      errorClass: "rate-limit",
      fromModel: FREE_A,
      toModel: FREE_B,
    })
    expect(h.notices).toContain(`[turn-retry] rotating model ${FREE_A} → ${FREE_B} (rate-limit)`)
    // The throttled model is now cooling down for every session.
    expect(h.cooldowns.isCooling(FREE_A)).toBe(true)
    expect(h.cooldowns.isCooling(FREE_B)).toBe(false)
    h.done()
  })

  it("no-output stall: interrupts the stuck turn, switches, then continues", async () => {
    const h = harness({
      scripts: ["hang", ok],
      turnRetry: { on: ["no-output-stall"], rotate: [{ model: FREE_B }], ...FAST },
    })
    const desc = h.spawn()
    const first = h.registry.sendPrompt(desc.id, "go")
    await until(() => h.registry.get(desc.id)?.busy === true, "turn start")
    expect(h.registry.markStalled(desc.id, Date.now())).toBe(true)
    await first
    await until(() => h.prompts.length === 2 && h.registry.get(desc.id)?.busy === false, "continuation turn")

    const order = h.trace.filter(t => t.startsWith("cancel") || t.startsWith("setModel") || t.startsWith("prompt"))
    expect(order.indexOf("cancel")).toBeGreaterThan(-1)
    expect(order.indexOf("cancel")).toBeLessThan(order.indexOf(`setModel:${FREE_B}`))
    expect(order.indexOf(`setModel:${FREE_B}`)).toBeLessThan(order.lastIndexOf(`prompt@${FREE_B}`))
    expect(h.events.find(e => e.phase === "rotated")).toMatchObject({
      errorClass: "no-output-stall",
      fromModel: FREE_A,
      toModel: FREE_B,
    })
    expect(h.registry.get(desc.id)?.model).toBe(FREE_B)
    h.done()
  })

  it("upstream-5xx only rotates when rotateOn opts in", async () => {
    const plain = harness({
      scripts: [fail("502 Bad Gateway"), ok],
      turnRetry: { on: ["upstream-5xx"], rotate: [{ model: FREE_B }], ...FAST },
    })
    const d1 = plain.spawn()
    await plain.registry.sendPrompt(d1.id, "go")
    await until(() => plain.prompts.length === 2, "continuation")
    expect(plain.phases()).toEqual(["scheduled", "sent"])
    expect(plain.registry.get(d1.id)?.model).toBe(FREE_A)
    plain.done()

    const opted = harness({
      scripts: [fail("502 Bad Gateway"), ok],
      turnRetry: { on: ["upstream-5xx"], rotate: [{ model: FREE_B }], rotateOn: ["upstream-5xx"], ...FAST },
    })
    const d2 = opted.spawn()
    await opted.registry.sendPrompt(d2.id, "go")
    await until(() => opted.prompts.length === 2, "continuation")
    expect(opted.phases()).toEqual(["scheduled", "rotated", "sent"])
    expect(opted.registry.get(d2.id)?.model).toBe(FREE_B)
    // A 5xx is not rate-limit evidence: nothing is put on cooldown.
    expect(opted.cooldowns.list()).toEqual([])
    opted.done()
  })

  it("skips a cooling target and takes the next one", async () => {
    const cooldowns = createModelCooldowns()
    cooldowns.mark(FREE_B, { durationMs: 60_000, reason: "rate-limit" })
    const h = harness({
      scripts: [fail("429 status code"), ok],
      cooldowns,
      turnRetry: { on: ["rate-limit"], rotate: [{ model: FREE_B }, { model: FREE_C }], ...FAST },
    })
    const desc = h.spawn()
    await h.registry.sendPrompt(desc.id, "go")
    await until(() => h.prompts.length === 2, "continuation")

    expect(h.registry.get(desc.id)?.model).toBe(FREE_C)
    expect(h.notices.find(n => n.includes("rotating model"))).toContain(`skipped ${FREE_B}: cooling down`)
    h.done()
  })

  it("all targets cooling: falls back to a same-model retry and says so", async () => {
    const cooldowns = createModelCooldowns()
    cooldowns.mark(FREE_B, { durationMs: 60_000, reason: "rate-limit" })
    cooldowns.mark(FREE_C, { durationMs: 60_000, reason: "rate-limit" })
    const h = harness({
      scripts: [fail("429 status code"), ok],
      cooldowns,
      turnRetry: { on: ["rate-limit"], rotate: [{ model: FREE_B }, { model: FREE_C }], ...FAST },
    })
    const desc = h.spawn()
    await h.registry.sendPrompt(desc.id, "go")
    await until(() => h.prompts.length === 2 && h.registry.get(desc.id)?.busy === false, "continuation turn")

    expect(h.trace.some(t => t.startsWith("setModel"))).toBe(false)
    expect(h.registry.get(desc.id)?.model).toBe(FREE_A)
    expect(h.phases()).toEqual(["scheduled", "sent"])
    const notice = h.notices.find(n => n.includes("no rotation target available"))
    expect(notice).toContain(`retrying ${FREE_A} after backoff`)
    expect(notice).toContain("cooling down")
    h.done()
  })

  it("a free session never rotates onto a paid id, even if the list was smuggled in", async () => {
    const h = harness({
      scripts: [fail("429 status code"), ok],
      turnRetry: { on: ["rate-limit"], rotate: [{ model: PAID }, { model: FREE_B }], ...FAST },
    })
    const desc = h.spawn()
    await h.registry.sendPrompt(desc.id, "go")
    await until(() => h.prompts.length === 2, "continuation")

    expect(h.trace).not.toContain(`setModel:${PAID}`)
    expect(h.registry.get(desc.id)?.model).toBe(FREE_B)
    expect(h.notices.find(n => n.includes("rotating model"))).toContain(`skipped ${PAID}: not in model list`)
    h.done()
  })

  it("only-paid list on a free session: same-model retry, never a switch", async () => {
    const h = harness({
      scripts: [fail("429 status code"), ok],
      turnRetry: { on: ["rate-limit"], rotate: [{ model: PAID }], ...FAST },
    })
    const desc = h.spawn()
    await h.registry.sendPrompt(desc.id, "go")
    await until(() => h.prompts.length === 2, "continuation")
    expect(h.trace.some(t => t.startsWith("setModel"))).toBe(false)
    expect(h.registry.get(desc.id)?.model).toBe(FREE_A)
    h.done()
  })

  it("a target outside the profile allow-list is skipped (eligibility check)", async () => {
    const profile: AuthProfile = { id: "zen", endpoint: "opencode", method: "api-key", models: { mode: "allow", ids: [FREE_C] } } as AuthProfile
    const check = createRotationTargetCheck({ getProfile: async id => (id === "zen" ? profile : undefined) })
    const h = harness({
      scripts: [fail("429 status code"), ok],
      check,
      accessProfile: { profileRef: "zen", endpoint: "opencode", method: "api-key" },
      turnRetry: { on: ["rate-limit"], rotate: [{ model: FREE_B }, { model: FREE_C }], ...FAST },
    })
    const desc = h.spawn()
    await h.registry.sendPrompt(desc.id, "go")
    await until(() => h.prompts.length === 2, "continuation")

    expect(h.registry.get(desc.id)?.model).toBe(FREE_C)
    expect(h.notices.find(n => n.includes("rotating model"))).toContain(`skipped ${FREE_B}: not in profile "zen"`)
    h.done()
  })

  it("v1 is same-profile: a target naming another profile is skipped", async () => {
    const h = harness({
      scripts: [fail("429 status code"), ok],
      accessProfile: { profileRef: "zen", endpoint: "opencode", method: "api-key" },
      turnRetry: {
        on: ["rate-limit"],
        rotate: [{ model: FREE_B, profileRef: "go" }, { model: FREE_C, profileRef: "zen" }],
        ...FAST,
      },
    })
    const desc = h.spawn()
    await h.registry.sendPrompt(desc.id, "go")
    await until(() => h.prompts.length === 2, "continuation")
    expect(h.registry.get(desc.id)?.model).toBe(FREE_C)
    expect(h.notices.find(n => n.includes("rotating model"))).toContain(`skipped ${FREE_B}: needs profile "go"`)
    h.done()
  })

  it("a switch the registry refuses is skipped, not fatal", async () => {
    const h = harness({
      scripts: [fail("429 status code"), ok],
      turnRetry: {
        on: ["rate-limit"],
        // A different route prefix ⇒ the live-switch route guard answers requires-restart.
        rotate: [{ model: "opencode-go/minimax-m3.1-flash-free" }, { model: FREE_B }],
        ...FAST,
      },
    })
    const desc = h.spawn()
    await h.registry.sendPrompt(desc.id, "go")
    await until(() => h.prompts.length === 2, "continuation")
    expect(h.registry.get(desc.id)?.model).toBe(FREE_B)
    expect(h.notices.find(n => n.includes("rotating model"))).toContain("opencode-go/minimax-m3.1-flash-free: switch not applied")
    h.done()
  })
})

describe("daemon-wide model cooldowns", () => {
  it("one session's 429 puts the model on cooldown for another session, until it expires", async () => {
    let t = 1_000_000
    const cooldowns = createModelCooldowns(() => t)
    const a = harness({
      scripts: [fail("429 status code"), ok],
      cooldowns,
      turnRetry: { on: ["rate-limit"], rotate: [{ model: FREE_C }], ...FAST },
    })
    const da = a.spawn()
    await a.registry.sendPrompt(da.id, "go")
    await until(() => a.prompts.length === 2, "session A continuation")
    expect(cooldowns.isCooling(FREE_A)).toBe(true)
    expect(cooldowns.list()[0]).toMatchObject({ model: FREE_A, reason: "rate-limit", sessionId: da.id })

    // Session B (same shared map) wants to rotate onto the model A just burned.
    const b = harness({
      scripts: [fail("429 status code"), ok],
      cooldowns,
      model: FREE_B,
      turnRetry: { on: ["rate-limit"], rotate: [{ model: FREE_A }, { model: FREE_C }], ...FAST },
    })
    const db = b.spawn()
    await b.registry.sendPrompt(db.id, "go")
    await until(() => b.prompts.length === 2, "session B continuation")
    expect(b.registry.get(db.id)?.model).toBe(FREE_C)
    expect(b.notices.find(n => n.includes("rotating model"))).toContain(`skipped ${FREE_A}: cooling down`)

    // After the default cooldown the model is eligible again.
    t += 10 * 60_000 + 1
    expect(cooldowns.isCooling(FREE_A)).toBe(false)
    expect(
      rotationTargetRejection({ id: "x", model: FREE_B } as SessionDescriptor, { model: FREE_A }, cooldowns, t),
    ).toBeUndefined()
    a.done()
    b.done()
  })

  it("honours Retry-After, clamps absurd hints, and never shortens an active cooldown", () => {
    let t = 0
    const c = createModelCooldowns(() => t)
    c.mark("m", { durationMs: 30_000, reason: "rate-limit" })
    expect(c.list()[0]?.remainingMs).toBe(30_000)
    c.mark("m", { durationMs: 1_000, reason: "rate-limit" })
    expect(c.list()[0]?.remainingMs).toBe(30_000)
    c.mark("long", { durationMs: 99 * 3_600_000, reason: "rate-limit" })
    expect(c.list().find(e => e.model === "long")?.remainingMs).toBe(3_600_000)
    t = 30_001
    expect(c.isCooling("m")).toBe(false)
    expect(c.list().map(e => e.model)).toEqual(["long"])
  })

  it("a retry-after hint in the error sets the cooldown length; cooldownMs is the fallback", async () => {
    const hinted = harness({
      scripts: [fail("Rate limited. Retry after 30s"), ok],
      turnRetry: { on: ["rate-limit"], rotate: [{ model: FREE_B }], cooldownMs: 120_000, ...FAST },
    })
    const d1 = hinted.spawn()
    await hinted.registry.sendPrompt(d1.id, "go")
    await until(() => hinted.prompts.length === 2, "continuation")
    const hintedMs = hinted.cooldowns.list().find(e => e.model === FREE_A)!.remainingMs
    expect(hintedMs).toBeGreaterThan(20_000)
    expect(hintedMs).toBeLessThanOrEqual(30_000)
    hinted.done()

    const plain = harness({
      scripts: [fail("429 status code"), ok],
      turnRetry: { on: ["rate-limit"], rotate: [{ model: FREE_B }], cooldownMs: 120_000, ...FAST },
    })
    const d2 = plain.spawn()
    await plain.registry.sendPrompt(d2.id, "go")
    await until(() => plain.prompts.length === 2, "continuation")
    const plainMs = plain.cooldowns.list().find(e => e.model === FREE_A)!.remainingMs
    expect(plainMs).toBeGreaterThan(100_000)
    expect(plainMs).toBeLessThanOrEqual(120_000)
    plain.done()
  })
})

describe("free stays free", () => {
  it.each([
    ["opencode/glm-5.3-flash-free", true],
    ["opencode/big-pickle", true],
    ["big-pickle", true],
    ["opencode-go/minimax-m3.1-flash-free@opencode", true],
    ["opencode/gpt-5.1-codex", false],
    ["opencode-go/glm-5.3", false],
    ["anthropic/claude-free-tier-not", false],
  ])("zero-cost membership (%s) = %s", (model, expected) => {
    expect(inModelList(model, ZERO_COST_LIST_ID, seedModelListSource())).toBe(expected)
  })

  it("validateTurnRetryRotate rejects free → paid and names the offenders", () => {
    const err = validateTurnRetryRotate([{ model: FREE_B }, { model: PAID }], FREE_A)
    expect(err).toContain("zero-cost")
    expect(err).toContain(PAID)
    expect(err).not.toContain(FREE_B + ",")
    expect(validateTurnRetryRotate([{ model: FREE_B }, { model: FREE_C }], FREE_A)).toBeUndefined()
    // A paid session may rotate anywhere; no model/rotate ⇒ nothing to check.
    expect(validateTurnRetryRotate([{ model: PAID }], "opencode/gpt-5.1")).toBeUndefined()
    expect(validateTurnRetryRotate(undefined, FREE_A)).toBeUndefined()
  })

  it("rotationTargetRejection refuses paid targets for a free session", () => {
    const c = createModelCooldowns()
    const free = { id: "x", model: FREE_A } as SessionDescriptor
    expect(rotationTargetRejection(free, { model: PAID }, c, Date.now())).toContain("not in model list")
    expect(rotationTargetRejection(free, { model: FREE_B }, c, Date.now())).toBeUndefined()
    expect(rotationTargetRejection(free, { model: FREE_A }, c, Date.now())).toContain("current model")
  })

  it("agent_start rejects a free → paid rotate list at spawn, before any adapter starts", async () => {
    const startSession = vi.fn(async () => ({}) as AgentSessionLike)
    const registry = createSessionsRegistry({ persist: false })
    const result = await spawnAgentSession(
      {
        registry,
        resolveAgentAdapter: async () => ({ startSession: startSession as never, commandPreview: "mock" }),
      },
      {
        adapter: "opencode",
        cwd: "/tmp",
        model: FREE_A,
        turnRetry: resolveTurnRetryPolicy({ on: ["rate-limit"], rotate: [{ model: PAID }] }),
      },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("turn_retry_rotate_invalid")
    expect(result.message).toContain(PAID)
    expect(startSession).not.toHaveBeenCalled()
    registry.shutdown()
  })
})

describe("turnRetry policy parsing", () => {
  it("accepts rotate / rotateOn / cooldownMs and keeps the legacy shape when absent", () => {
    expect(parseTurnRetryPolicy("rate-limit")).not.toHaveProperty("rotate")
    const p = parseTurnRetryPolicy({
      on: ["rate-limit"],
      rotate: [{ model: FREE_B }, { model: FREE_C, profileRef: "zen" }],
      cooldownMs: 90_000,
    })
    expect(p?.rotate).toEqual([{ model: FREE_B }, { model: FREE_C, profileRef: "zen" }])
    expect(p?.rotateOn).toEqual(["rate-limit", "no-output-stall"])
    expect(p?.cooldownMs).toBe(90_000)
  })
  it("rejects malformed rotate input whole", () => {
    expect(parseTurnRetryPolicy({ on: ["rate-limit"], rotate: [{ model: "" }] })).toBeUndefined()
    expect(parseTurnRetryPolicy({ on: ["rate-limit"], rotate: "big-pickle" })).toBeUndefined()
    expect(parseTurnRetryPolicy({ on: ["rate-limit"], cooldownMs: 0 })).toBeUndefined()
  })
})

describe("presets carry turnRetry.rotate", () => {
  let prevHome: string | undefined
  let home: string
  beforeEach(async () => {
    prevHome = process.env.HOME
    home = await mkdtemp(join(tmpdir(), "agp-rotate-presets-"))
    process.env.HOME = home
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    await rm(home, { recursive: true, force: true })
  })

  const deps = {
    getProfile: async (id: string): Promise<AuthProfile | undefined> =>
      id === "zen" ? ({ id: "zen", endpoint: "opencode", method: "api-key" } as AuthProfile) : undefined,
  }

  it("a harness preset stores turnRetry incl. rotate", async () => {
    await addHarnessPreset(
      {
        id: "oc-free",
        harnessSlug: "opencode",
        name: "Free pool",
        profileRef: "zen",
        defaultModel: FREE_A,
        isDefault: false,
        turnRetry: { on: ["rate-limit"], rotate: [{ model: FREE_B }] },
      },
      deps,
    )
    const { getHarnessPreset } = await import("../harness-preset-store.js")
    expect((await getHarnessPreset("oc-free"))?.turnRetry?.rotate).toEqual([{ model: FREE_B }])
  })

  it("a harness preset rejects free → paid", async () => {
    await expect(
      addHarnessPreset(
        {
          id: "oc-bad",
          harnessSlug: "opencode",
          name: "Bad",
          profileRef: "zen",
          defaultModel: FREE_A,
          isDefault: false,
          turnRetry: { on: ["rate-limit"], rotate: [{ model: PAID }] },
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(HarnessPresetValidationError)
  })

  it("a user preset rejects free → paid and accepts a free pool", async () => {
    await expect(
      saveUserPreset({
        id: "bad",
        label: "Bad",
        model: FREE_A,
        turnRetry: { on: ["rate-limit"], rotate: [{ model: PAID }] },
      }),
    ).rejects.toThrow(/free/)
    await saveUserPreset({
      id: "good",
      label: "Good",
      model: FREE_A,
      turnRetry: { on: ["rate-limit"], rotate: [{ model: FREE_B }] },
    })
  })
})

describe("daemon_health exposes modelCooldowns", () => {
  it("lists the active cooldowns, read-only", async () => {
    const cooldowns = createModelCooldowns()
    cooldowns.mark(FREE_A, { durationMs: 60_000, reason: "rate-limit", sessionId: "s1" })
    const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
    registerDaemonHealthTools(server, {
      workspace: "/tmp",
      registered: [],
      startedAt: Date.now(),
      resumeSessionsOnBoot: false,
      idleReapAfterMs: 0,
      modelCooldowns: () => cooldowns.list(),
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "test-client", version: "0" })
    await client.connect(clientTransport)
    const result = await client.callTool({ name: "daemon_health", arguments: {} })
    const body = JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text)
    expect(body.modelCooldowns).toEqual([
      expect.objectContaining({ model: FREE_A, reason: "rate-limit", sessionId: "s1" }),
    ])
    await client.close()
  })
})
