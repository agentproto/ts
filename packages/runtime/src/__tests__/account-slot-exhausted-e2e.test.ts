/**
 * End to end, the scenario the design is for: a multi-account slot [A, B] on one preset.
 *
 *   1. A answers "Insufficient balance" mid-session: the session continues on B,
 *      same model, with context; A is `exhausted` with an `until`.
 *   2. A new spawn on the slot takes B directly.
 *   3. A and B both exhausted: the spawn is refused with the typed
 *      `account_slot_exhausted`, carrying the nearest return time.
 *   4. `until` has passed: A is the first choice again, with no manual unblock.
 *
 * Real registry, event bus, turn-retry controller and spawn path; only the
 * adapter sessions are scripted (the billed account decides whether a turn
 * fails) and the account health file lives in a temp dir.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { addAuthProfile, registerSubaccountProvider, unregisterSubaccountProvider, type AuthProfile } from "@agentproto/auth"
import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent, type SessionDescriptor, type SessionsRegistry } from "../sessions.js"
import { createSessionEventBus, type SessionEventBus } from "../session-event-bus.js"
import { createTurnRetryController, type TurnRetryController } from "../turn-retry.js"
import { createAccountHealthStore, type AccountHealthStore } from "../account-health.js"
import { createModelCooldowns } from "../model-cooldowns.js"
import { cdContractLine } from "../agents-md.js"
import type { AdapterAuthDescriptor } from "../spawn-defaults.js"
import type { UserPreset } from "../user-presets.js"

const T0 = Date.parse("2026-11-15T10:00:00Z")
const H = 3_600_000
const MIN = 60_000
const GO_EMPTY = "AI_APICallError: Insufficient balance. Top up at https://opencode.ai/console/org_X/billing?credits=1."
const DESCRIPTOR: AdapterAuthDescriptor = {
  provider: "anthropic",
  authSubscription: { setEnv: "ANTHROPIC_AUTH_TOKEN" },
  gatewayAuth: { setEnv: "ANTHROPIC_AUTH_TOKEN" },
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe("account slot, health and preset fallback, end to end", () => {
  let dir: string
  let clock: number
  let registry: SessionsRegistry
  let sessionEvents: SessionEventBus
  let health: AccountHealthStore
  let controller: TurnRetryController
  let deps: SpawnAgentSessionDeps
  /** Accounts whose wallet is empty: a turn billed to them fails with the real opencode message. */
  let emptyWallets: Set<string>
  const prompts: Array<{ account: string; text: string }> = []

  const cheap: UserPreset = {
    id: "usage-cheap",
    label: "Cheap",
    harness: "opencode",
    model: "claude-haiku-4-5",
    access: { profileRef: "slot:opencode-go" },
    turnRetry: { on: ["usage-limit"] },
  }
  const presets = [cheap]

  const spawnCheap = () =>
    spawnAgentSession(deps, { adapter: "opencode", cwd: "/tmp", preset: cheap, sessionPresets: presets })
  const alive = (): SessionDescriptor[] => registry.list().filter(d => d.status === "running" || d.status === "starting")

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agp-slot-e2e-"))
    clock = T0
    emptyWallets = new Set()
    prompts.length = 0
    for (const id of ["ws01", "ws003"]) {
      const profile: AuthProfile = { id, endpoint: "anthropic", method: "api-key", subaccount: { kind: "org", id } }
      await addAuthProfile(profile)
    }
    registerSubaccountProvider({
      id: "fake-vendor",
      endpoints: ["anthropic"],
      kinds: ["org"],
      list: async () => ({ account: { id: "acct" }, subaccounts: [] }),
      resolve: async (profile: AuthProfile) => ({ credential: `token-of-${profile.id}-0001` }),
    })
    health = createAccountHealthStore({ dir, now: () => clock })
    sessionEvents = createSessionEventBus()
    registry = createSessionsRegistry({ sessionEvents, persist: false })
    const cooldowns = createModelCooldowns(() => clock)
    const slots = { "opencode-go": ["ws01", "ws003"] }
    deps = {
      registry,
      accountHealth: health,
      loadAccountSlots: async () => slots,
      resolveAgentAdapter: async () => ({
        commandPreview: "fake",
        authDescriptor: DESCRIPTOR,
        startSession: (async (opts: unknown): Promise<AgentSessionLike> => {
          const credential = (opts as { auth?: { credential?: string } }).auth?.credential ?? ""
          const account = credential.replace(/^token-of-/, "").replace(/-0001$/, "")
          return {
            sessionId: `fake-${account}`,
            async *send(message: unknown): AsyncIterable<AgentStreamEvent> {
              prompts.push({ account, text: typeof message === "string" ? message : JSON.stringify(message) })
              if (emptyWallets.has(account)) {
                yield { kind: "error", error: { message: GO_EMPTY } }
                yield { kind: "turn-end", reason: "error" }
                return
              }
              yield { kind: "text-delta", text: "ok\n" }
              yield { kind: "turn-end", reason: "completed" }
            },
            async cancel() {},
            async close() {},
          }
        }) as unknown as (opts: unknown) => Promise<AgentSessionLike>,
      }),
      resolveAgentsMd: async () => ({ mode: "absent", contractLine: cdContractLine }),
      resolveWorkspaceRules: async () => ({}),
    }
    controller = createTurnRetryController({
      registry: {
        get: registry.get,
        list: registry.list,
        enqueuePrompt: registry.enqueuePrompt,
        patchTurnRetry: registry.patchTurnRetry,
        setModel: registry.setModel,
        interruptSession: registry.interruptSession,
        recordNotice: registry.recordNotice,
      },
      sessionEvents,
      accountHealth: health,
      cooldowns,
      loadAccountSlots: async () => slots,
      now: () => clock,
      // The daemon's restart hook: re-spawn on the (slot) access, same model, with the policy.
      restartSession: async (prev, overrides) => {
        const result = await spawnAgentSession(deps, {
          adapter: prev.adapterSlug ?? "opencode",
          cwd: "/tmp",
          model: overrides.model ?? prev.model!,
          access: overrides.access ?? { profileRef: prev.accessProfile!.profileRef },
          ...(prev.turnRetry ? { turnRetry: prev.turnRetry } : {}),
        })
        if (!result.ok) throw new Error(result.message)
        return result.descriptor
      },
      log: () => {},
    })
  })
  afterEach(async () => {
    controller.dispose()
    unregisterSubaccountProvider("fake-vendor")
    registry.shutdown()
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it("A empty -> the session moves to B, A is exhausted; a new spawn takes B; A and B empty -> refused; until passed -> A again", async () => {
    // 1. A session on the slot's first account, A (ws01), whose wallet is empty.
    const first = await spawnCheap()
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.descriptor.accessProfile?.profileRef).toBe("ws01")
    expect(first.descriptor.accessSlot).toBe("opencode-go")
    emptyWallets.add("ws01")
    await registry.sendPrompt(first.descriptor.id, "work")

    // The session continues on B, same model, with the continuation prompt.
    await until(() => alive().some(d => d.accessProfile?.profileRef === "ws003"), "session on B")
    const onB = alive().find(d => d.accessProfile?.profileRef === "ws003")!
    expect(onB.model).toBe("claude-haiku-4-5")
    expect(onB.accessSlot).toBe("opencode-go")
    await until(() => prompts.some(p => p.account === "ws003" && p.text.includes("Continue where you stopped")), "continuation on B")

    // A is exhausted, with an until (no time in the message: 30 min backoff).
    const a = await health.get("ws01")
    expect(a).toMatchObject({ state: "exhausted", untilBasis: "estimated", strikes: 1 })
    expect(Date.parse(a!.until)).toBe(T0 + 30 * MIN)
    expect(await health.get("ws003")).toBeUndefined()

    // 2. A new spawn on the slot takes B directly, no degradation.
    const second = await spawnCheap()
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.descriptor.accessProfile?.profileRef).toBe("ws003")

    // 3. B runs dry too: every account of the slot is spent, the spawn is refused with
    //    the typed error and the nearest return time, and nothing starts.
    await health.mark("ws003", { reason: GO_EMPTY, until: T0 + 6 * H, untilBasis: "observed" })
    const startsBefore = prompts.length
    const third = await spawnCheap()
    expect(third.ok).toBe(false)
    if (third.ok) return
    expect(third.code).toBe("account_slot_exhausted")
    expect(third.details).toMatchObject({ slot: "opencode-go", retryAfter: new Date(T0 + 30 * MIN).toISOString() })
    expect(prompts.length).toBe(startsBefore)

    // 4. Time passes beyond A's until: A is the first choice again, nothing was unblocked by hand.
    clock = T0 + 31 * MIN
    expect(await health.get("ws01")).toMatchObject({ state: "probing" })
    const fourth = await spawnCheap()
    expect(fourth.ok).toBe(true)
    if (!fourth.ok) return
    expect(fourth.descriptor.accessProfile?.profileRef).toBe("ws01")

    // A's wallet was topped up: its next clean turn clears the entry.
    emptyWallets.delete("ws01")
    await registry.sendPrompt(fourth.descriptor.id, "work")
    await until(() => registry.get(fourth.descriptor.id)?.busy === false && registry.get(fourth.descriptor.id)?.turnsCompleted === 1, "clean turn")
    for (let i = 0; i < 200 && (await health.get("ws01")); i++) await new Promise(resolve => setTimeout(resolve, 5))
    expect(await health.get("ws01")).toBeUndefined()
  })
})
