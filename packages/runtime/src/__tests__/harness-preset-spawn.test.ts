/**
 * Spawn-path integration for harness default presets (harness-presets.json).
 *
 * When a spawn pins NEITHER an explicit `access.profileRef` NOR one via a user
 * preset, `spawnAgentSession` falls back to the harness's default preset — its
 * `profileRef` + `defaultModel` replace the legacy "first eligible profile"
 * ambient resolution. These tests mock the preset store (so no real
 * `~/.agentproto/harness-presets.json` is read) and the auth profile/keychain
 * reads (same seam the sibling `session-spawn.test.ts` mocks), then assert the
 * preset's model reaches the wire and its profile lands on the descriptor.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { AuthProfile } from "@agentproto/auth"
import type { CatalogProvider } from "@agentproto/model-catalog"

// The harness default preset the spawn path should fall back to. A test that
// wants "no default" sets this to undefined.
const presetState = vi.hoisted(() => ({
  value: undefined as
    | { id: string; harnessSlug: string; name: string; profileRef: string; defaultModel: string; isDefault: boolean }
    | undefined,
}))
vi.mock("../harness-preset-store.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../harness-preset-store.js")>()
  return {
    ...actual,
    getDefaultHarnessPreset: vi.fn(async (_slug: string) => presetState.value),
  }
})

// Deterministic named-profile + keychain reads — the `access.profileRef`
// resolution branch. `eligibleProfiles` stays real (pure endpoint/method).
const authProfileState = vi.hoisted(() => ({
  profiles: {} as Record<string, AuthProfile>,
  keychain: {} as Record<string, string | undefined>,
}))
vi.mock("@agentproto/auth", async importOriginal => {
  const actual = await importOriginal<typeof import("@agentproto/auth")>()
  return {
    ...actual,
    getAuthProfile: vi.fn(async (id: string) => authProfileState.profiles[id]),
    KeychainStore: vi.fn().mockImplementation(() => ({
      read: vi.fn(async ({ path }: { path: string }) => {
        const value = authProfileState.keychain[path]
        return value !== undefined ? { value, kind: "pat" as const } : undefined
      }),
    })),
  }
})

import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { getDefaultHarnessPreset } from "../harness-preset-store.js"
import type { AgentAdapterResolver } from "../http-server.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
} from "../sessions.js"

function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: "acp_test",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

/** An adapter with a FIXED api-key provider (e.g. openrouter) so eligibility is
 *  a clean endpoint/method match, independent of model→provider derivation. */
function depsWithProvider(
  provider: CatalogProvider,
  startSession: ReturnType<typeof vi.fn>,
): SpawnAgentSessionDeps {
  const resolveAgentAdapter: AgentAdapterResolver = async () => ({
    startSession,
    commandPreview: "mock-adapter",
    authDescriptor: { provider },
  })
  return { registry: createSessionsRegistry({ persist: false }), resolveAgentAdapter }
}

function eligibleProfile(over: Partial<AuthProfile> = {}): AuthProfile {
  return {
    id: "openrouter-cheap",
    endpoint: "openrouter",
    method: "api-key",
    credentialRef: "or/key",
    ...over,
  }
}

describe("spawnAgentSession — harness default preset fallback", () => {
  // Reset the hoisted mock state + call history between tests so one test's
  // preset/profile setup never bleeds into the next.
  beforeEach(() => {
    presetState.value = undefined
    authProfileState.profiles = {}
    authProfileState.keychain = {}
    vi.clearAllMocks()
  })

  it("fills an unpinned access.profileRef + model from the harness default preset", async () => {
    presetState.value = {
      id: "hm-cheap",
      harnessSlug: "hermes",
      name: "Cheap",
      profileRef: "openrouter-cheap",
      defaultModel: "z-ai/glm-5.2",
      isDefault: true,
    }
    authProfileState.profiles["openrouter-cheap"] = eligibleProfile()
    authProfileState.keychain["or/key"] = "sk-or-test"

    const startSession = vi.fn(async () => fakeAgentSession())
    const deps = depsWithProvider("openrouter", startSession)

    const result = await spawnAgentSession(deps, { adapter: "hermes", cwd: "/tmp" })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")

    // Preset model reached the wire...
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ model: "z-ai/glm-5.2" }))
    // ...and the preset's profile is pinned on the descriptor.
    expect(result.descriptor.accessProfile).toMatchObject({ profileRef: "openrouter-cheap" })
    // The default preset was consulted under the harness slug.
    expect(getDefaultHarnessPreset).toHaveBeenCalledWith("hermes")
  })

  it("prefers the spawn's `harness` slug over `adapter` when looking up the default", async () => {
    presetState.value = undefined
    const startSession = vi.fn(async () => fakeAgentSession())
    const deps = depsWithProvider("openrouter", startSession)

    const result = await spawnAgentSession(deps, {
      adapter: "mock",
      harness: "hermes",
      cwd: "/tmp",
    })
    expect(result.ok).toBe(true)
    expect(getDefaultHarnessPreset).toHaveBeenCalledWith("hermes")
  })

  it("an explicit access.profileRef wins — the harness default is never consulted", async () => {
    presetState.value = {
      id: "hm-cheap",
      harnessSlug: "hermes",
      name: "Cheap",
      profileRef: "openrouter-cheap",
      defaultModel: "z-ai/glm-5.2",
      isDefault: true,
    }
    authProfileState.profiles["openrouter-pinned"] = eligibleProfile({
      id: "openrouter-pinned",
      credentialRef: "or/pinned",
    })
    authProfileState.keychain["or/pinned"] = "sk-or-pinned"

    const startSession = vi.fn(async () => fakeAgentSession())
    const deps = depsWithProvider("openrouter", startSession)

    const result = await spawnAgentSession(deps, {
      adapter: "hermes",
      cwd: "/tmp",
      access: { profileRef: "openrouter-pinned" },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(result.descriptor.accessProfile).toMatchObject({ profileRef: "openrouter-pinned" })
    // Short-circuited before the default lookup — the explicit pin already
    // satisfied `input.access?.profileRef`.
    expect(getDefaultHarnessPreset).not.toHaveBeenCalled()
  })

  it("an explicit model wins over the preset's defaultModel (profile still pinned)", async () => {
    presetState.value = {
      id: "hm-cheap",
      harnessSlug: "hermes",
      name: "Cheap",
      profileRef: "openrouter-cheap",
      defaultModel: "z-ai/glm-5.2",
      isDefault: true,
    }
    authProfileState.profiles["openrouter-cheap"] = eligibleProfile()
    authProfileState.keychain["or/key"] = "sk-or-test"

    const startSession = vi.fn(async () => fakeAgentSession())
    const deps = depsWithProvider("openrouter", startSession)

    const result = await spawnAgentSession(deps, {
      adapter: "hermes",
      cwd: "/tmp",
      model: "deepseek/deepseek-v4-pro",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: "deepseek/deepseek-v4-pro" }),
    )
    expect(result.descriptor.accessProfile).toMatchObject({ profileRef: "openrouter-cheap" })
  })

  it("no default preset ⇒ the spawn is untouched (no profile pinned)", async () => {
    presetState.value = undefined
    const startSession = vi.fn(async () => fakeAgentSession())
    const deps = depsWithProvider("openrouter", startSession)

    const result = await spawnAgentSession(deps, { adapter: "hermes", cwd: "/tmp" })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected spawn")
    expect(result.descriptor.accessProfile).toBeUndefined()
  })
})
