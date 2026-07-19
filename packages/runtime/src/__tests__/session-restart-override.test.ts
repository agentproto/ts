/**
 * Restart-with-override coverage (SPEC §4.3, build step 6) — the single path
 * for the four restart-only axes, plus the load-bearing money-safety guarantees
 * that ride the `access` axis:
 *
 *   - R1 money bug: a restart requesting a DIFFERENT named auth profile must
 *     bill/authenticate as THAT profile, never the prior descriptor's wallet
 *     and never an ambient/config fallback — even when the old wallet is still
 *     sitting in config. The regression test below locks that.
 *   - Rx/Ry eligibility: a profile whose vendor/method isn't eligible for the
 *     resolved (adapter × route) endpoint is rejected with a
 *     `RestartOverrideError` (status 400) — never silently swapped for a wallet
 *     that happens to fit.
 *   - Round-trip: each overridden axis lands on the fresh descriptor and a
 *     `session:config-changed` event is emitted for it.
 *
 * Mirrors the mock style of session-restart-auth.test.ts — `startSession` is a
 * stub that re-implements the driver's own `missing_auth_credential` fail-fast,
 * and the access-profile resolution is injected (never touches the real
 * keychain / profile store).
 */

import { describe, it, expect } from "vitest"

import {
  restartAgentSession,
  RestartOverrideError,
  type AccessProfileResolver,
} from "../session-restart-core.js"
import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { SessionEvent } from "../session-event-bus.js"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { AdapterAuthDescriptor } from "../spawn-defaults.js"
import type { AuthProfile } from "@agentproto/auth"

let acpCounter = 0
function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `acp_${acpCounter++}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

type CapturedStart = {
  auth?: {
    mode: "subscription" | "api-key"
    credential?: string
    setEnv: string
    unsetEnv: string[]
    explicit: boolean
    enforce: "always" | "when-configured"
  }
  model?: string
  effort?: string
  mode?: string
}

/** Adapter resolver whose `startSession` replicates the driver's own
 *  `missing_auth_credential` fail-fast (an ENGAGED spec with no credential
 *  throws) and records what it was handed. */
function makeResolver(descriptor: AdapterAuthDescriptor | undefined): {
  resolver: AgentAdapterResolver
  captured: CapturedStart[]
} {
  const captured: CapturedStart[] = []
  const resolver: AgentAdapterResolver = async () => ({
    startSession: async (o: CapturedStart) => {
      const authSpec = o.auth
      const engaged = !!authSpec && (authSpec.enforce === "always" || authSpec.explicit === true)
      if (authSpec && engaged && !authSpec.credential) {
        throw new Error(
          `missing_auth_credential: auth mode "${authSpec.mode}" requires an explicit credential`,
        )
      }
      captured.push({ auth: authSpec, model: o.model, effort: o.effort, mode: o.mode })
      return fakeAgentSession()
    },
    commandPreview: "mock-adapter",
    ...(descriptor ? { authDescriptor: descriptor } : {}),
  })
  return { resolver, captured }
}

const CLAUDE_CODE_DESC: AdapterAuthDescriptor = {
  provider: "anthropic",
  authEnforce: "always",
  authSubscription: {
    setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
    conflictEnv: ["ANTHROPIC_AUTH_TOKEN"],
    unsetEnvAdd: ["CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_BASE_URL"],
  },
}
const CODEX_DESC: AdapterAuthDescriptor = { provider: "openai" }

/** Injected profile resolver returning a fixed table. */
function profileResolver(
  table: Record<string, { profile: AuthProfile; credential?: string }>,
): AccessProfileResolver {
  return async (ref: string) => table[ref]
}

function spawnClaudeSubSession(registry: ReturnType<typeof createSessionsRegistry>) {
  return registry.spawnAgent({
    workspaceSlug: "default",
    cwd: "/tmp",
    agentSession: fakeAgentSession(),
    adapterSlug: "claude-code",
    auth: {
      mode: "subscription",
      fingerprint: "subscription · sk-ant-oat…OLD1",
      provider: "anthropic",
      credentialSource: "explicit-config",
      setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
    },
  })
}

describe("restartAgentSession — restart-with-override (step 6)", () => {
  it("R1 money bug: an access override bills the REQUESTED profile, never the prior wallet even when it's still in config", async () => {
    const { resolver, captured } = makeResolver(CLAUDE_CODE_DESC)
    const registry = createSessionsRegistry({ persist: false })
    // Prior session ran on the Claude-Max SUBSCRIPTION wallet.
    const prev = spawnClaudeSubSession(registry)

    const requested: AuthProfile = {
      id: "work-anthropic-key",
      vendor: "anthropic",
      method: "api-key",
      credentialRef: "kc:work-anthropic-key",
      label: "Work Anthropic key",
    }

    const restarted = await restartAgentSession(registry, resolver, prev, {
      forceAgentResume: true,
      // The prior subscription wallet is STILL sitting in config — the override
      // must NOT fall back to it.
      loadDefaultsConfig: async () => ({
        adapters: { "claude-code": { auth: { token: "sk-ant-oat01-PRIORWALLET9999" } } },
      }),
      overrides: { access: { profileRef: "work-anthropic-key" } },
      resolveAccessProfile: profileResolver({
        "work-anthropic-key": { profile: requested, credential: "sk-ant-api03-REQUESTED4242" },
      }),
    })

    // Authenticated as the REQUESTED api-key profile, not the prior subscription.
    expect(captured[0]?.auth).toMatchObject({
      mode: "api-key",
      credential: "sk-ant-api03-REQUESTED4242",
      setEnv: "ANTHROPIC_API_KEY",
      explicit: true,
    })
    // Never the prior wallet's credential or its env var.
    expect(captured[0]?.auth?.credential).not.toBe("sk-ant-oat01-PRIORWALLET9999")
    expect(captured[0]?.auth?.setEnv).not.toBe("CLAUDE_CODE_OAUTH_TOKEN")

    // Descriptor echoes the new billing + the attached profile identity.
    expect(restarted.desc.auth).toMatchObject({
      mode: "api-key",
      provider: "anthropic",
      credentialSource: "explicit-config",
      setEnv: "ANTHROPIC_API_KEY",
      fingerprint: "api-key · sk-ant-api…4242",
    })
    expect(restarted.desc.accessProfile).toEqual({
      profileRef: "work-anthropic-key",
      label: "Work Anthropic key",
      vendor: "anthropic",
      method: "api-key",
    })
  })

  it("switching between two subscription-vendor profiles re-resolves the OAuth bearer for the new one", async () => {
    const { resolver, captured } = makeResolver(CLAUDE_CODE_DESC)
    const registry = createSessionsRegistry({ persist: false })
    const prev = spawnClaudeSubSession(registry)

    const otherMax: AuthProfile = {
      id: "personal-max",
      vendor: "anthropic",
      method: "oauth-bearer",
      credentialRef: "kc:personal-max",
      label: "Personal Max",
    }

    const restarted = await restartAgentSession(registry, resolver, prev, {
      forceAgentResume: true,
      overrides: { access: { profileRef: "personal-max" } },
      resolveAccessProfile: profileResolver({
        "personal-max": { profile: otherMax, credential: "sk-ant-oat01-PERSONAL7777" },
      }),
    })

    expect(captured[0]?.auth).toMatchObject({
      mode: "subscription",
      credential: "sk-ant-oat01-PERSONAL7777",
      setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
      explicit: true,
    })
    // Subscription mode scrubs the gateway/api-key envs (money hygiene).
    expect(captured[0]?.auth?.unsetEnv).toContain("ANTHROPIC_BASE_URL")
    expect(restarted.desc.accessProfile?.profileRef).toBe("personal-max")
  })

  it("Rx: a vendor-mismatched profile is rejected with a 400 and spawns nothing", async () => {
    const { resolver, captured } = makeResolver(CLAUDE_CODE_DESC)
    const registry = createSessionsRegistry({ persist: false })
    const prev = spawnClaudeSubSession(registry)
    const before = registry.list().length

    const wrongVendor: AuthProfile = {
      id: "my-openai-key",
      vendor: "openai",
      method: "api-key",
      credentialRef: "kc:my-openai-key",
    }

    const err = await restartAgentSession(registry, resolver, prev, {
      forceAgentResume: true,
      overrides: { access: { profileRef: "my-openai-key" } },
      resolveAccessProfile: profileResolver({
        "my-openai-key": { profile: wrongVendor, credential: "sk-proj-whatever0000" },
      }),
    }).catch(e => e)

    expect(err).toBeInstanceOf(RestartOverrideError)
    expect((err as RestartOverrideError).status).toBe(400)
    expect((err as RestartOverrideError).message).toMatch(/not eligible/)
    // No spawn happened — the reject is BEFORE startSession.
    expect(captured).toHaveLength(0)
    expect(registry.list()).toHaveLength(before)
  })

  it("Ry: a method the adapter can't present on the route is rejected with a 400", async () => {
    // codex presents api-key only (no authSubscription) — an oauth-bearer
    // profile for its own vendor is still ineligible (method gate, SPEC §1c).
    const { resolver, captured } = makeResolver(CODEX_DESC)
    const registry = createSessionsRegistry({ persist: false })
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgentSession(),
      adapterSlug: "codex",
      model: "gpt-5-codex",
      auth: {
        mode: "api-key",
        fingerprint: "api-key · sk-proj-…OLD1",
        provider: "openai",
        credentialSource: "providers-store",
        setEnv: "OPENAI_API_KEY",
      },
    })

    const bearerForApiKeyOnly: AuthProfile = {
      id: "openai-bearer",
      vendor: "openai",
      method: "oauth-bearer",
      credentialRef: "kc:openai-bearer",
    }

    const err = await restartAgentSession(registry, resolver, prev, {
      forceAgentResume: true,
      overrides: { access: { profileRef: "openai-bearer" } },
      resolveAccessProfile: profileResolver({
        "openai-bearer": { profile: bearerForApiKeyOnly, credential: "tok-bearer-xyz" },
      }),
    }).catch(e => e)

    expect(err).toBeInstanceOf(RestartOverrideError)
    expect((err as RestartOverrideError).status).toBe(400)
    expect(captured).toHaveLength(0)
  })

  it("an unknown access profileRef is a 400", async () => {
    const { resolver } = makeResolver(CLAUDE_CODE_DESC)
    const registry = createSessionsRegistry({ persist: false })
    const prev = spawnClaudeSubSession(registry)

    const err = await restartAgentSession(registry, resolver, prev, {
      forceAgentResume: true,
      overrides: { access: { profileRef: "does-not-exist" } },
      resolveAccessProfile: profileResolver({}),
    }).catch(e => e)

    expect(err).toBeInstanceOf(RestartOverrideError)
    expect((err as RestartOverrideError).status).toBe(400)
    expect((err as RestartOverrideError).message).toMatch(/no auth profile/)
  })

  it("overrides apply each restart-only axis onto the fresh descriptor and emit config-changed events", async () => {
    const { resolver, captured } = makeResolver(CLAUDE_CODE_DESC)
    const bus = createSessionEventBus()
    const seen: SessionEvent[] = []
    bus.on("session:config-changed", ev => seen.push(ev))
    const registry = createSessionsRegistry({ persist: false, sessionEvents: bus })
    const prev = spawnClaudeSubSession(registry)

    const restarted = await restartAgentSession(registry, resolver, prev, {
      forceAgentResume: true,
      // No access override here, so the base auth path re-resolves the prior
      // subscription wallet from config — provide it so the fail-fast driver
      // stub gets a credential.
      loadDefaultsConfig: async () => ({
        adapters: { "claude-code": { auth: { token: "sk-ant-oat01-still9999" } } },
      }),
      overrides: {
        model: "claude-opus-4-8",
        effort: "ultracode",
        route: { gateway: "moonshot" },
        posture: "plan",
        contextProfile: "lean",
      },
    })

    // Each axis round-trips onto the new descriptor (SPEC §3.7).
    expect(restarted.desc.model).toBe("claude-opus-4-8")
    expect(restarted.desc.effort).toBe("ultracode")
    expect(restarted.desc.route).toEqual({ gateway: "moonshot" })
    expect(restarted.desc.posture).toBe("plan")
    expect(restarted.desc.contextProfile).toBe("lean")

    // model + effort are forwarded to the driver's spawn inputs.
    expect(captured[0]?.model).toBe("claude-opus-4-8")
    expect(captured[0]?.effort).toBe("ultracode")

    // One config-changed event per overridden axis, on the NEW session id.
    const axes = seen
      .filter(ev => ev.type === "session:config-changed")
      .map(ev => (ev as { axis: string }).axis)
      .sort()
    expect(axes).toEqual(["contextProfile", "effort", "model", "posture", "route"])
    for (const ev of seen) {
      expect((ev as { sessionId: string }).sessionId).toBe(restarted.desc.id)
    }
  })

  it("omitted axes are carried forward from the prior descriptor (single-axis restart never drops the rest)", async () => {
    const { resolver } = makeResolver(CLAUDE_CODE_DESC)
    const registry = createSessionsRegistry({ persist: false })
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: fakeAgentSession(),
      adapterSlug: "claude-code",
      model: "claude-opus-4-8",
      posture: "plan",
      contextProfile: "lean",
      auth: {
        mode: "subscription",
        fingerprint: "subscription · sk-ant-oat…OLD1",
        provider: "anthropic",
        credentialSource: "explicit-config",
        setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
      },
    })

    const restarted = await restartAgentSession(registry, resolver, prev, {
      forceAgentResume: true,
      // Override ONLY effort; everything else must survive.
      overrides: { effort: "high" },
      loadDefaultsConfig: async () => ({
        adapters: { "claude-code": { auth: { token: "sk-ant-oat01-still9999" } } },
      }),
    })

    expect(restarted.desc.effort).toBe("high")
    expect(restarted.desc.model).toBe("claude-opus-4-8")
    expect(restarted.desc.posture).toBe("plan")
    expect(restarted.desc.contextProfile).toBe("lean")
  })

  it("a plain restart (no overrides) still emits no config-changed event", async () => {
    const { resolver } = makeResolver(CLAUDE_CODE_DESC)
    const bus = createSessionEventBus()
    const seen: SessionEvent[] = []
    bus.on("session:config-changed", ev => seen.push(ev))
    const registry = createSessionsRegistry({ persist: false, sessionEvents: bus })
    const prev = spawnClaudeSubSession(registry)

    await restartAgentSession(registry, resolver, prev, {
      forceAgentResume: true,
      loadDefaultsConfig: async () => ({
        adapters: { "claude-code": { auth: { token: "sk-ant-oat01-still9999" } } },
      }),
    })

    expect(seen.filter(ev => ev.type === "session:config-changed")).toHaveLength(0)
  })
})
