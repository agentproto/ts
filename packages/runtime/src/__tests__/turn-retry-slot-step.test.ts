/**
 * The implicit slot step of the turnRetry controller: a session billed to an
 * account of a slot that hits an account cap (usage cap or empty wallet) marks
 * that account exhausted and continues, with context, on the next account of
 * the same slot and the same model. No `turnRetry.fallback` line is needed for
 * it, and it runs before the fallback list. A single-account slot, a rejected
 * key (auth) and a multi-account slot with nothing left all leave it alone.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AgentSessionLike, AgentStreamEvent, SessionDescriptor } from "../sessions.js"
import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus, type SessionFallbackEvent } from "../session-event-bus.js"
import { createTurnRetryController } from "../turn-retry.js"
import { resolveTurnRetryPolicy } from "../turn-retry-policy.js"
import { createAccountHealthStore } from "../account-health.js"
import type { AccountSlots } from "../account-slots.js"

const T0 = Date.parse("2026-11-15T10:00:00Z")
const GO_EMPTY = "AI_APICallError: Insufficient balance. Top up at https://opencode.ai/console/org_X/billing?credits=1."
const MODEL = "opencode-go/deepseek-v4.1-flash"

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const fail = (message: string): AgentStreamEvent[] => [
  { kind: "error", error: { message } },
  { kind: "turn-end", reason: "error" },
]

function scripted(scripts: AgentStreamEvent[][]): AgentSessionLike {
  let turn = 0
  return {
    sessionId: "scripted",
    async *send() {
      const script = scripts[Math.min(turn, scripts.length - 1)]!
      turn += 1
      for (const evt of script) yield evt
    },
    async cancel() {},
    async close() {},
  }
}

describe("turnRetry implicit slot step", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agp-slot-ctl-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  function harness(opts: {
    slots: AccountSlots
    slot?: string
    profileRef?: string
    message?: string
    fallback?: Array<{ model?: string; access?: { profileRef: string } }>
    on?: Array<"usage-limit">
  }) {
    const health = createAccountHealthStore({ dir, now: () => T0 })
    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persist: false })
    const notices: string[] = []
    const restarts: Array<{ id: string; overrides: { model?: string; access?: { profileRef: string } } }> = []
    const prompts: string[] = []
    const fallbackEvents: SessionFallbackEvent[] = []
    sessionEvents.on("session:fallback", ev => fallbackEvents.push(ev))
    const controller = createTurnRetryController({
      registry: {
        get: registry.get,
        list: registry.list,
        enqueuePrompt: async (id, message, o) => {
          prompts.push(`${id}:${typeof message === "string" ? message : ""}`)
          return registry.enqueuePrompt(id, message, o)
        },
        patchTurnRetry: registry.patchTurnRetry,
        setModel: registry.setModel,
        interruptSession: registry.interruptSession,
        recordNotice: (id, text) => {
          notices.push(text)
          return registry.recordNotice(id, text)
        },
      },
      sessionEvents,
      accountHealth: health,
      loadAccountSlots: async () => opts.slots,
      getAuthProfile: async () => ({}),
      now: () => T0,
      restartSession: async (prev: SessionDescriptor, overrides) => {
        restarts.push({ id: prev.id, overrides })
        // the real hook mints a new session on the account the slot resolves to
        return registry.spawnAgent({
          workspaceSlug: "default",
          cwd: "/tmp",
          agentSession: scripted([[{ kind: "turn-end", reason: "completed" }]]),
          adapterSlug: "opencode",
          model: overrides.model ?? prev.model,
          accessProfile: { profileRef: "next", endpoint: "opencode-go", method: "api-key" },
          turnRetry: prev.turnRetry,
        })
      },
      log: () => {},
    })
    const desc = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: scripted([fail(opts.message ?? GO_EMPTY)]),
      adapterSlug: "opencode",
      model: MODEL,
      accessProfile: { profileRef: opts.profileRef ?? "ws01", endpoint: "opencode-go", method: "api-key" },
      ...(opts.slot ? { accessSlot: opts.slot } : {}),
      turnRetry: resolveTurnRetryPolicy({
        on: opts.on ?? ["usage-limit"],
        ...(opts.fallback ? { fallback: opts.fallback } : {}),
        baseDelayMs: 5,
        factor: 1,
        maxDelayMs: 5,
      }),
    })
    return {
      health,
      registry,
      desc,
      notices,
      restarts,
      prompts,
      fallbackEvents,
      done: () => {
        controller.dispose()
        registry.shutdown()
      },
    }
  }

  it("marks the empty account and continues on the next account of the slot, same model, no fallback list", async () => {
    const h = harness({ slots: { "opencode-go": ["ws01", "ws003"] }, slot: "opencode-go" })
    await h.registry.sendPrompt(h.desc.id, "go")
    await until(() => h.restarts.length === 1, "slot restart")

    expect(await h.health.get("ws01")).toMatchObject({ state: "exhausted", untilBasis: "estimated" })
    // restart is handed the SLOT: the successor records accessSlot and the
    // resolver picks the first open account of the slot
    expect(h.restarts[0]).toEqual({ id: h.desc.id, overrides: { access: { profileRef: "slot:opencode-go" } } })
    expect(h.fallbackEvents[0]).toMatchObject({
      transition: "restart",
      from: { model: MODEL, accessProfileRef: "ws01" },
      to: { model: MODEL, accessProfileRef: "ws003" },
    })
    expect(h.notices.join("\n")).toMatch(/slot "opencode-go": account "ws01" is exhausted, continuing on "ws003"/)
    await until(() => h.prompts.some(p => p.includes("Continue where you stopped")), "continuation prompt")
    h.done()
  })

  it("works for a session that never opted into usage-limit (the account cap is not retryable, the slot step still runs)", async () => {
    const h = harness({ slots: { "opencode-go": ["ws01", "ws003"] }, slot: "opencode-go", on: [] as never })
    await h.registry.sendPrompt(h.desc.id, "go")
    await until(() => h.restarts.length === 1, "slot restart")
    h.done()
  })

  it("every account of the slot spent: no slot move, the fallback list takes over", async () => {
    const h = harness({
      slots: { "opencode-go": ["ws01", "ws003"] },
      slot: "opencode-go",
      fallback: [{ access: { profileRef: "zen-account" } }],
    })
    await h.health.mark("ws003", { reason: "402", until: T0 + 5 * 3_600_000, untilBasis: "observed" })
    await h.registry.sendPrompt(h.desc.id, "go")
    await until(() => h.restarts.length === 1, "fallback restart")
    // the one restart is the fallback step (an access overlay), not a slot move
    expect(h.restarts[0]?.overrides).toEqual({ access: { profileRef: "zen-account" } })
    expect(h.notices.join("\n")).toMatch(/slot "opencode-go" has no other account/)
    h.done()
  })

  it("a single-account slot is not a multi-account slot: nothing moves without a fallback list", async () => {
    const h = harness({ slots: { "opencode-go": "ws01" }, slot: "opencode-go" })
    await h.registry.sendPrompt(h.desc.id, "go")
    await until(() => h.notices.some(n => n.includes("not retrying")), "give-up notice")
    expect(h.restarts).toHaveLength(0)
    h.done()
  })

  it("a rejected key (auth) never moves the session to another account", async () => {
    const h = harness({
      slots: { "opencode-go": ["ws01", "ws003"] },
      slot: "opencode-go",
      message: "401 Unauthorized: invalid x-api-key",
    })
    await h.registry.sendPrompt(h.desc.id, "go")
    await until(() => h.notices.some(n => n.includes("not retrying")), "skip notice")
    expect(h.restarts).toHaveLength(0)
    expect(await h.health.list()).toEqual([])
    h.done()
  })

  it("a session that is not on a slot is left alone", async () => {
    const h = harness({ slots: { "opencode-go": ["ws01", "ws003"] } })
    await h.registry.sendPrompt(h.desc.id, "go")
    await until(() => h.notices.some(n => n.includes("not retrying")), "skip notice")
    expect(h.restarts).toHaveLength(0)
    h.done()
  })
})
