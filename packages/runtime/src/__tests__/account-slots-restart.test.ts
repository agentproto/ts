/**
 * Restart with an account slot: a `slot:<name>` access override is resolved
 * against the CURRENT `accountSlots` (that is how a turnRetry fallback and
 * `accounts swap --move-alive` land on the right account), and the
 * descriptor's `accessSlot` is recomputed on every restart.
 *
 * Mirrors session-restart-override.test.ts: the adapter is a stub and the
 * access-profile resolution is injected (no keychain, no profile file).
 */

import { describe, it, expect, vi } from "vitest"
import type { AuthProfile } from "@agentproto/auth"

import { restartAgentSession, RestartOverrideError, type AccessProfileResolver } from "../session-restart-core.js"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { AdapterAuthDescriptor } from "../spawn-defaults.js"

const profiles = vi.hoisted(() => ({ byId: {} as Record<string, import("@agentproto/auth").AuthProfile> }))
vi.mock("@agentproto/auth", async importOriginal => {
  const actual = await importOriginal<typeof import("@agentproto/auth")>()
  return { ...actual, getAuthProfile: vi.fn(async (id: string) => profiles.byId[id]) }
})

let n = 0
function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `acp_slot_${n++}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

const DESC: AdapterAuthDescriptor = { provider: "anthropic" }

function resolverCapturing(): { resolver: AgentAdapterResolver; credentials: Array<string | undefined> } {
  const credentials: Array<string | undefined> = []
  const resolver: AgentAdapterResolver = async () => ({
    startSession: async (o: { auth?: { credential?: string } }) => {
      credentials.push(o.auth?.credential)
      return fakeAgentSession()
    },
    commandPreview: "mock-adapter",
    authDescriptor: DESC,
  })
  return { resolver, credentials }
}

// No `credentialRef`: a keep-access restart re-resolves through the default
// store resolver, which then never reads the OS keychain from a test.
function keyProfile(id: string): AuthProfile {
  return { id, endpoint: "anthropic", method: "api-key" }
}

const resolveAccessProfile: AccessProfileResolver = async ref =>
  profiles.byId[ref] ? { profile: profiles.byId[ref]!, credential: `secret-${ref}` } : undefined

function setup(slots: Record<string, string>) {
  profiles.byId = { "acct-a": keyProfile("acct-a"), "acct-b": keyProfile("acct-b") }
  const registry = createSessionsRegistry({ persist: false })
  const prev = registry.spawnAgent({
    workspaceSlug: "default",
    cwd: "/tmp",
    agentSession: fakeAgentSession(),
    adapterSlug: "claude-code",
    accessProfile: { profileRef: "acct-a", endpoint: "anthropic", method: "api-key" },
    accessSlot: "claude-primary",
  })
  const state = { slots }
  return { registry, prev, state, loadAccountSlots: async () => state.slots }
}

describe("restart with an account slot", () => {
  it("a slot override resolves against the current slots and records accessSlot", async () => {
    const { registry, prev, loadAccountSlots } = setup({ "claude-primary": "acct-b", "claude-secondary": "acct-a" })
    const { resolver, credentials } = resolverCapturing()

    const restarted = await restartAgentSession(registry, resolver, prev, {
      forceAgentResume: true,
      overrides: { access: { profileRef: "slot:claude-primary" } },
      resolveAccessProfile,
      loadAccountSlots,
      loadDefaultsConfig: async () => undefined,
    })

    expect(credentials[0]).toBe("secret-acct-b")
    expect(restarted.desc.accessProfile?.profileRef).toBe("acct-b")
    expect(restarted.desc.accessSlot).toBe("claude-primary")
  })

  it("an unknown slot in the override is a 400 and starts nothing", async () => {
    const { registry, prev, loadAccountSlots } = setup({ "claude-primary": "acct-a" })
    const { resolver, credentials } = resolverCapturing()

    const err = await restartAgentSession(registry, resolver, prev, {
      forceAgentResume: true,
      overrides: { access: { profileRef: "slot:claude-tertiary" } },
      resolveAccessProfile,
      loadAccountSlots,
    }).catch(e => e)

    expect(err).toBeInstanceOf(RestartOverrideError)
    expect(err.message).toMatch(/claude-tertiary/)
    expect(credentials).toHaveLength(0)
  })

  it("a literal override clears accessSlot", async () => {
    const { registry, prev, loadAccountSlots } = setup({ "claude-primary": "acct-a" })
    const { resolver } = resolverCapturing()
    const restarted = await restartAgentSession(registry, resolver, prev, {
      forceAgentResume: true,
      overrides: { access: { profileRef: "acct-b" } },
      resolveAccessProfile,
      loadAccountSlots,
      loadDefaultsConfig: async () => undefined,
    })
    expect(restarted.desc.accessProfile?.profileRef).toBe("acct-b")
    expect(restarted.desc.accessSlot).toBeUndefined()
  })

  it("a restart that keeps its access keeps accessSlot only while the slot still points at its profile", async () => {
    const same = setup({ "claude-primary": "acct-a" })
    const kept = await restartAgentSession(same.registry, resolverCapturing().resolver, same.prev, {
      forceAgentResume: true,
      loadAccountSlots: same.loadAccountSlots,
      loadDefaultsConfig: async () => undefined,
    })
    expect(kept.desc.accessProfile?.profileRef).toBe("acct-a")
    expect(kept.desc.accessSlot).toBe("claude-primary")

    // The slot moved on (a swap without --move-alive): the session stays on
    // its account, and no longer claims the slot.
    const moved = setup({ "claude-primary": "acct-b" })
    const dropped = await restartAgentSession(moved.registry, resolverCapturing().resolver, moved.prev, {
      forceAgentResume: true,
      loadAccountSlots: moved.loadAccountSlots,
      loadDefaultsConfig: async () => undefined,
    })
    expect(dropped.desc.accessProfile?.profileRef).toBe("acct-a")
    expect(dropped.desc.accessSlot).toBeUndefined()
  })
})
