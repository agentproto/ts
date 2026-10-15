import { describe, expect, it } from "vitest"
import {
  eligibleProfiles,
  methodsPresentable,
  resolveEndpoint,
  type AdapterAuthManifest,
} from "../eligibility.js"
import type { AuthProfile } from "../profile-types.js"

/**
 * Fixture manifests built from verified adapter facts (not imported — this
 * package does not depend on the driver/adapter packages, see eligibility.ts
 * header comment):
 *
 * claude-code (adapters/claude-code/src/index.ts):
 *   - direct route → vendor "anthropic". Presents BOTH methods: oauth-bearer
 *     via `authSubscription.setEnv: "CLAUDE_CODE_OAUTH_TOKEN"` (:92-95) and
 *     api-key via `models.env: { anthropic: "ANTHROPIC_API_KEY" }` (:133).
 *   - moonshot route → vendor "moonshot". The gateway mode rewrites
 *     ANTHROPIC_BASE_URL and scrubs the ambient ANTHROPIC_API_KEY
 *     (CLAUDE_CODE_GATEWAY_ENV_UNSET, :238-250) — the operator supplies the
 *     gateway key via `auth_token` (api-key only); no oauth-bearer path
 *     exists for a third-party gateway.
 *
 * hermes (adapters/hermes/HERMES.md:22, SECRETS.md:7-8):
 *   - direct route → vendor "anthropic". `auth.state.env` declares
 *     ANTHROPIC_API_KEY (api-key) as a secret slot; hermes declares no
 *     authSubscription-equivalent, so oauth-bearer is never presentable —
 *     "method, not adapter, is the gate" (SPEC §1c).
 */
const CLAUDE_CODE_MANIFEST: AdapterAuthManifest = {
  id: "claude-code",
  endpointByRoute: {
    direct: "anthropic",
    moonshot: "moonshot",
  },
  methodsByRoute: {
    direct: ["oauth-bearer", "api-key"],
    moonshot: ["api-key"],
  },
}

const HERMES_MANIFEST: AdapterAuthManifest = {
  id: "hermes",
  endpointByRoute: {
    direct: "anthropic",
  },
  methodsByRoute: {
    direct: ["api-key"],
  },
}

const anthropicOauth: AuthProfile = {
  id: "jeremy-max",
  endpoint: "anthropic",
  method: "oauth-bearer",
  credentialRef: "ref-oauth",
}
const anthropicApiKey: AuthProfile = {
  id: "work-anthropic-key",
  endpoint: "anthropic",
  method: "api-key",
  credentialRef: "ref-api-key",
}
const moonshotApiKey: AuthProfile = {
  id: "personal-moonshot",
  endpoint: "moonshot",
  method: "api-key",
  credentialRef: "ref-moonshot",
}

describe("resolveEndpoint", () => {
  it("resolves the billing endpoint for a given (adapter, route)", () => {
    expect(resolveEndpoint(CLAUDE_CODE_MANIFEST, "direct")).toEqual({
      endpoint: "anthropic",
    })
    expect(resolveEndpoint(CLAUDE_CODE_MANIFEST, "moonshot")).toEqual({
      endpoint: "moonshot",
    })
  })

  it("throws for a route the manifest declares no vendor for", () => {
    expect(() => resolveEndpoint(CLAUDE_CODE_MANIFEST, "openrouter")).toThrow(
      /claude-code.*openrouter/,
    )
  })
})

describe("methodsPresentable", () => {
  it("claude-code presents both methods on the direct route", () => {
    expect(methodsPresentable(CLAUDE_CODE_MANIFEST, "direct")).toEqual([
      "oauth-bearer",
      "api-key",
    ])
  })

  it("claude-code presents only api-key on a gateway route", () => {
    expect(methodsPresentable(CLAUDE_CODE_MANIFEST, "moonshot")).toEqual(["api-key"])
  })

  it("hermes presents only api-key, never oauth-bearer", () => {
    expect(methodsPresentable(HERMES_MANIFEST, "direct")).toEqual(["api-key"])
  })
})

describe("eligibleProfiles — the (vendor × method) predicate", () => {
  const allProfiles = [anthropicOauth, anthropicApiKey, moonshotApiKey]

  it("claude-code + route:direct → both anthropic profiles eligible", () => {
    const eligible = eligibleProfiles(allProfiles, CLAUDE_CODE_MANIFEST, "direct")
    expect(eligible.map(p => p.id).sort()).toEqual([
      "jeremy-max",
      "work-anthropic-key",
    ])
  })

  it("claude-code + route:moonshot → moonshot profile eligible, anthropic oauth NOT (vendor mismatch)", () => {
    const eligible = eligibleProfiles(allProfiles, CLAUDE_CODE_MANIFEST, "moonshot")
    expect(eligible.map(p => p.id)).toEqual(["personal-moonshot"])
    expect(eligible).not.toContainEqual(anthropicOauth)
  })

  it("hermes + anthropic → api-key eligible, oauth-bearer NOT (method not presentable)", () => {
    const eligible = eligibleProfiles(allProfiles, HERMES_MANIFEST, "direct")
    expect(eligible.map(p => p.id)).toEqual(["work-anthropic-key"])
    expect(eligible).not.toContainEqual(anthropicOauth)
  })

  it("no eligible profiles when none match the resolved vendor", () => {
    const eligible = eligibleProfiles([anthropicOauth, anthropicApiKey], CLAUDE_CODE_MANIFEST, "moonshot")
    expect(eligible).toEqual([])
  })

  it("skips a whole-profile-disabled profile (WS2)", () => {
    const disabledOauth: AuthProfile = { ...anthropicOauth, disabled: true }
    const eligible = eligibleProfiles(
      [disabledOauth, anthropicApiKey],
      CLAUDE_CODE_MANIFEST,
      "direct",
    )
    // Only the still-enabled api-key survives; the disabled oauth drops out.
    expect(eligible.map(p => p.id)).toEqual(["work-anthropic-key"])
  })

  it("an explicit `disabled: false` stays eligible (absent-means-enabled)", () => {
    const explicitlyEnabled: AuthProfile = { ...anthropicApiKey, disabled: false }
    const eligible = eligibleProfiles([explicitlyEnabled], CLAUDE_CODE_MANIFEST, "direct")
    expect(eligible.map(p => p.id)).toEqual(["work-anthropic-key"])
  })
})

describe("eligibleProfiles — the `routes` cross-route rule", () => {
  // The opencode shape: one credential billed on BOTH the Go (`opencode-go`)
  // and Zen (`opencode`) routes, declared as endpoint "opencode" + routes
  // ["opencode-go"]. The portable-key twin of the console-org rule.
  const opencodeManifest = (endpoint: string): AdapterAuthManifest => ({
    id: "opencode",
    endpointByRoute: { direct: endpoint },
    methodsByRoute: { direct: ["api-key"] },
  })

  const multiRouteKey: AuthProfile = {
    id: "ws03",
    endpoint: "opencode",
    routes: ["opencode-go"],
    method: "api-key",
    credentialRef: "ref-ws03",
  }

  it("admits the profile on a declared secondary route AND on its primary endpoint", () => {
    expect(
      eligibleProfiles([multiRouteKey], opencodeManifest("opencode-go"), "direct").map(p => p.id),
    ).toEqual(["ws03"])
    expect(
      eligibleProfiles([multiRouteKey], opencodeManifest("opencode"), "direct").map(p => p.id),
    ).toEqual(["ws03"])
  })

  it("without `routes`, the same key stays single-route (unchanged behavior)", () => {
    const zenOnly: AuthProfile = { ...multiRouteKey, routes: undefined }
    expect(eligibleProfiles([zenOnly], opencodeManifest("opencode-go"), "direct")).toEqual([])
    expect(
      eligibleProfiles([zenOnly], opencodeManifest("opencode"), "direct").map(p => p.id),
    ).toEqual(["ws03"])
  })

  it("an empty `routes` list does not widen eligibility", () => {
    const empty: AuthProfile = { ...multiRouteKey, routes: [] }
    expect(eligibleProfiles([empty], opencodeManifest("opencode-go"), "direct")).toEqual([])
  })

  it("a disabled profile is still skipped even with `routes`", () => {
    const disabled: AuthProfile = { ...multiRouteKey, disabled: true }
    expect(eligibleProfiles([disabled], opencodeManifest("opencode-go"), "direct")).toEqual([])
  })
})
