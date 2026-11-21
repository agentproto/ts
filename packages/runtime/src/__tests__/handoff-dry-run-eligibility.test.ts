/**
 * `validateHandoffSpawnEligibility` — the dry-run gate `POST
 * /sessions/:id/handoff` (`dryRun: true`) runs BEFORE building any
 * checkpoint preview. Issue 2026-11-21: a dry run of the brain handoff
 * (claude-code → mistral-vibe) previewed OK, and only the REAL handoff
 * failed with `access_profile_ineligible` — the source's inherited profile
 * was never validated against the target adapter+route. The gate computes
 * the EXACT access the real handoff would spawn with (explicit override or
 * the source's carried wallet — `carriedContinueAccess`) and runs it through
 * the SAME eligibility ladder the spawn runs, refusing with the same code
 * and message — which now also SUGGESTS the eligible stored profiles.
 */

import { describe, expect, it, vi } from "vitest"

const authProfileState: { profiles: Record<string, any> } = { profiles: {} }

vi.mock("@agentproto/auth", async importOriginal => {
  const actual = await importOriginal<typeof import("@agentproto/auth")>()
  return {
    ...actual,
    getAuthProfile: vi.fn(async (id: string) => authProfileState.profiles[id]),
    listAuthProfiles: vi.fn(async () => Object.values(authProfileState.profiles)),
    KeychainStore: vi.fn().mockImplementation(() => ({
      read: vi.fn(async () => ({ value: "stored-key", kind: "api-key" as const })),
    })),
  }
})

import { validateHandoffSpawnEligibility } from "../session-continue-fresh.js"
import type { SessionDescriptor } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

const MISTRAL_DESCRIPTOR = { provider: "mistral" }

let prevSeq = 0
function makePrev(over: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: `sess_prev_${++prevSeq}`,
    kind: "agent-cli",
    status: "running",
    startedAt: new Date().toISOString(),
    adapterSlug: "claude-code",
    harness: "claude-code",
    model: "claude-opus-5-5",
    cwd: "/tmp/repo",
    ...over,
  } as SessionDescriptor
}

function resolverBySlug(
  bySlug: Record<string, { authDescriptor?: unknown; defaultModel?: string } | null>,
): AgentAdapterResolver {
  return (async (slug: string) =>
    (bySlug[slug] ?? null) as never) as AgentAdapterResolver
}

describe("validateHandoffSpawnEligibility (handoff --dry-run gate)", () => {
  it("the report's scenario: the source's inherited profile is refused for the target adapter+route, and the refusal SUGGESTS the eligible profile", async () => {
    authProfileState.profiles = {
      "claude-subs-agentik": {
        id: "claude-subs-agentik",
        endpoint: "anthropic",
        method: "oauth-bearer",
        credentialRef: "agentproto.auth.anthropic.sub",
      },
      // The profile that WOULD have worked but was invisible to every
      // discovery surface (issue §5).
      "mistral-vibe-pro": {
        id: "mistral-vibe-pro",
        endpoint: "mistral",
        method: "api-key",
        credentialRef: "agentproto.auth.mistral.mistral-vibe-pro",
        models: { mode: "allow", ids: ["mistral-large-4-0", "zai-glm-5-3"] },
      },
    }
    const prev = makePrev({
      accessProfile: { profileRef: "claude-subs-agentik", endpoint: "anthropic", method: "oauth-bearer" },
    })
    const refusal = await validateHandoffSpawnEligibility(
      {
        resolveAgentAdapter: resolverBySlug({
          "mistral-vibe": { authDescriptor: MISTRAL_DESCRIPTOR, defaultModel: "mistral-large-4-0" },
        }),
      },
      prev,
      { harness: "mistral-vibe", model: "mistral-large-4-0" },
    )
    expect(refusal?.ok).toBe(false)
    expect(refusal?.code).toBe("access_profile_ineligible")
    const message = referralMessage(refusal!)
    expect(message).toContain('profile "claude-subs-agentik" (anthropic/oauth-bearer) is not eligible')
    expect(message).toContain('for adapter "mistral-vibe" on route "mistral"')
    // The fix, in the same breath: which profile to pass.
    expect(message).toContain("Eligible stored profile(s) for this route: mistral-vibe-pro")
  })

  it("an explicit --profile override of the eligible profile validates clean (undefined refusal)", async () => {
    authProfileState.profiles = {
      "mistral-vibe-pro": {
        id: "mistral-vibe-pro",
        endpoint: "mistral",
        method: "api-key",
        credentialRef: "agentproto.auth.mistral.mistral-vibe-pro",
        models: { mode: "allow", ids: ["mistral-large-4-0", "zai-glm-5-3"] },
      },
    }
    const prev = makePrev({
      accessProfile: { profileRef: "claude-subs-agentik", endpoint: "anthropic", method: "oauth-bearer" },
    })
    const refusal = await validateHandoffSpawnEligibility(
      {
        resolveAgentAdapter: resolverBySlug({
          "mistral-vibe": { authDescriptor: MISTRAL_DESCRIPTOR, defaultModel: "mistral-large-4-0" },
        }),
      },
      prev,
      { harness: "mistral-vibe", model: "mistral-large-4-0", access: { profileRef: "mistral-vibe-pro" } },
    )
    expect(refusal).toBeUndefined()
  })

  it("a named profile that does not exist is a hard error (fail closed)", async () => {
    authProfileState.profiles = {}
    const prev = makePrev()
    const refusal = await validateHandoffSpawnEligibility(
      {
        resolveAgentAdapter: resolverBySlug({
          "mistral-vibe": { authDescriptor: MISTRAL_DESCRIPTOR, defaultModel: "mistral-large-4-0" },
        }),
      },
      prev,
      { harness: "mistral-vibe", access: { profileRef: "ghost" } },
    )
    expect(refusal?.ok).toBe(false)
    expect(refusal?.code).toBe("access_profile_not_found")
  })

  it("an unresolvable target harness refuses with the spawn's own adapter_not_found", async () => {
    authProfileState.profiles = {}
    const prev = makePrev()
    const refusal = await validateHandoffSpawnEligibility(
      { resolveAgentAdapter: resolverBySlug({}) },
      prev,
      { harness: "nope" },
    )
    expect(refusal?.ok).toBe(false)
    expect(refusal?.code).toBe("adapter_not_found")
    expect(referralMessage(refusal!)).toContain('adapter "nope" could not be resolved')
  })

  it("a source that names no wallet (and no override) has nothing to validate — undefined", async () => {
    authProfileState.profiles = {}
    const prev = makePrev()
    const refusal = await validateHandoffSpawnEligibility(
      {
        resolveAgentAdapter: resolverBySlug({
          "mistral-vibe": { authDescriptor: MISTRAL_DESCRIPTOR, defaultModel: "mistral-large-4-0" },
        }),
      },
      prev,
      { harness: "mistral-vibe" },
    )
    expect(refusal).toBeUndefined()
  })

  it("a model outside the profile's allow-list is refused and names the profile(s) that WOULD bill the model", async () => {
    authProfileState.profiles = {
      "mistral-vibe-pro": {
        id: "mistral-vibe-pro",
        endpoint: "mistral",
        method: "api-key",
        credentialRef: "agentproto.auth.mistral.mistral-vibe-pro",
        models: { mode: "allow", ids: ["zai-glm-5-3"] },
      },
      "mistral-api": {
        id: "mistral-api",
        endpoint: "mistral",
        method: "api-key",
        credentialRef: "agentproto.auth.mistral.mistral-api",
      },
    }
    const prev = makePrev()
    const refusal = await validateHandoffSpawnEligibility(
      {
        resolveAgentAdapter: resolverBySlug({
          "mistral-vibe": { authDescriptor: MISTRAL_DESCRIPTOR, defaultModel: "mistral-large-4-0" },
        }),
      },
      prev,
      { harness: "mistral-vibe", model: "mistral-large-4-0", access: { profileRef: "mistral-vibe-pro" } },
    )
    expect(refusal?.ok).toBe(false)
    expect(refusal?.code).toBe("access_profile_ineligible")
    const message = referralMessage(refusal!)
    expect(message).toContain('does not allow model "mistral-large-4-0"')
    expect(message).toContain('Profile(s) that WOULD bill "mistral-large-4-0" on this route: mistral-api')
  })
})

function referralMessage(refusal: { message: string }): string {
  return refusal.message
}
