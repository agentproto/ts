/**
 * `turnRetry.fallback` with account slots: `fallbackBase` keeps the
 * `slot:<name>` ref and the slot is resolved when the fallback FIRES, not at
 * spawn. So a swap made while the session lives sends its fallback to the
 * account the slot points at now.
 *
 * Hermetic, same harness shape as turn-retry-fallback.test.ts: real registry
 * + event bus, scripted adapter sessions, injected restart and slot map.
 */

import { describe, expect, it } from "vitest"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"
import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus, type SessionFallbackEvent } from "../session-event-bus.js"
import { createTurnRetryController } from "../turn-retry.js"
import { resolveTurnRetryPolicy } from "../turn-retry-policy.js"
import { resolveProfileRef } from "../account-slots.js"

const FAST = { baseDelayMs: 5, factor: 1, maxDelayMs: 5 }
const WEEKLY = "Internal error: You've hit your weekly limit · resets 12pm (Europe/Paris)"

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

function harness(opts: {
  slots: Record<string, string>
  fallback: Array<{ access: { profileRef: string } }>
  accessProfileRef: string
  accessSlot?: string
}) {
  const state = { slots: { ...opts.slots } }
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const restarts: Array<{ id: string; access?: { profileRef: string } }> = []
  const notices: string[] = []
  const fallbackEvents: SessionFallbackEvent[] = []
  sessionEvents.on("session:fallback", ev => fallbackEvents.push(ev))
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
    getAuthProfile: async () => ({}),
    resolveProfileRef: ref =>
      resolveProfileRef(ref, { loadAccountSlots: async () => state.slots, getAuthProfile: async () => ({}) }),
    restartSession: async (prev, overrides) => {
      restarts.push({ id: prev.id, ...(overrides.access ? { access: overrides.access } : {}) })
      return prev
    },
    log: () => {},
  })
  const desc = registry.spawnAgent({
    workspaceSlug: "default",
    cwd: "/tmp",
    agentSession: scripted([fail(WEEKLY)]),
    adapterSlug: "claude-code",
    model: "claude-sonnet-5-5",
    accessProfile: { profileRef: opts.accessProfileRef, endpoint: "anthropic", method: "oauth-bearer" },
    ...(opts.accessSlot ? { accessSlot: opts.accessSlot } : {}),
    turnRetry: resolveTurnRetryPolicy({ on: ["usage-limit"], fallback: opts.fallback, ...FAST }),
  })
  return {
    state,
    registry,
    desc,
    restarts,
    notices,
    fallbackEvents,
    done: () => {
      controller.dispose()
      registry.shutdown()
    },
  }
}

describe("turnRetry fallback on account slots", () => {
  it("after a swap, an alive session on the departing account falls back onto the new primary", async () => {
    // Spawned on slot:claude-primary = acct-a, with the recommended chain
    // [primary, secondary]. Then the operator swaps: primary = acct-b.
    const h = harness({
      slots: { "claude-primary": "acct-a", "claude-secondary": "acct-b" },
      accessProfileRef: "acct-a",
      accessSlot: "claude-primary",
      fallback: [{ access: { profileRef: "slot:claude-primary" } }, { access: { profileRef: "slot:claude-secondary" } }],
    })
    h.state.slots = { "claude-primary": "acct-b", "claude-secondary": "acct-a" }

    await h.registry.sendPrompt(h.desc.id, "go")
    await until(() => h.restarts.length === 1, "fallback restart")

    // The restart is handed the SLOT (the successor records accessSlot), and
    // the fallback event names the account it resolved to now.
    expect(h.restarts[0]).toEqual({ id: h.desc.id, access: { profileRef: "slot:claude-primary" } })
    expect(h.fallbackEvents[0]).toMatchObject({ transition: "restart", to: { accessProfileRef: "acct-b" } })
    // fallbackBase keeps the slot ref for the next step, unresolved.
    expect(h.registry.get(h.desc.id)?.fallbackBase?.accessProfileRef).toBe("slot:claude-primary")
    h.done()
  })

  it("the same chain before any swap skips the account the session is already on", async () => {
    const h = harness({
      slots: { "claude-primary": "acct-a", "claude-secondary": "acct-b" },
      accessProfileRef: "acct-a",
      accessSlot: "claude-primary",
      fallback: [{ access: { profileRef: "slot:claude-primary" } }, { access: { profileRef: "slot:claude-secondary" } }],
    })
    await h.registry.sendPrompt(h.desc.id, "go")
    await until(() => h.restarts.length === 1, "fallback restart")
    expect(h.restarts[0]?.access).toEqual({ profileRef: "slot:claude-secondary" })
    expect(h.fallbackEvents[0]).toMatchObject({ to: { accessProfileRef: "acct-b" } })
    h.done()
  })

  it("a slot re-pointed while the session lives is followed (resolved at fallback time, not spawn)", async () => {
    const h = harness({
      slots: { "claude-secondary": "acct-b" },
      accessProfileRef: "acct-a",
      fallback: [{ access: { profileRef: "slot:claude-secondary" } }],
    })
    h.state.slots = { "claude-secondary": "acct-c" }
    await h.registry.sendPrompt(h.desc.id, "go")
    await until(() => h.restarts.length === 1, "fallback restart")
    expect(h.fallbackEvents[0]).toMatchObject({ to: { accessProfileRef: "acct-c" } })
    h.done()
  })

  it("an unknown slot is skipped with an explicit notice, never a silent fallback", async () => {
    const h = harness({
      slots: {},
      accessProfileRef: "acct-a",
      fallback: [{ access: { profileRef: "slot:claude-secondary" } }],
    })
    await h.registry.sendPrompt(h.desc.id, "go")
    await until(() => h.notices.some(n => n.includes("fallback chain exhausted")), "exhausted notice")
    expect(h.restarts).toHaveLength(0)
    expect(h.notices.join("\n")).toMatch(/claude-secondary.*not defined/)
    h.done()
  })
})
