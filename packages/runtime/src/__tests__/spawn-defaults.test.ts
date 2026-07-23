/**
 * Unit coverage for the pure `defaults` resolver (spawn-defaults.ts) —
 * config.json's global/per-adapter `skills`+`options`+`auth` merged against
 * an explicit `agent_start` call, and the adapter-shape folding of `skills`
 * into `options.skills`. No fs, no adapters — see session-spawn.test.ts
 * for the wiring into `spawnAgentSession`.
 */

import { describe, it, expect, vi } from "vitest"
import {
  resolveSpawnDefaults,
  normalizeSkillsOption,
  credentialFingerprint,
  resolveAuthSpec,
  AuthResolutionError,
  resolveSubscriptionCredential,
  SubscriptionSourceError,
  CLAUDE_CODE_OAUTH_SOURCE,
  type SpawnDefaultsConfig,
  type AdapterAuthDescriptor,
} from "../spawn-defaults.js"

// resolveSpawnDefaults now surfaces RAW auth material; with nothing
// configured that's just `{ explicit: false }`.
const NO_AUTH = { auth: { explicit: false } }

// The claude-code auth descriptor the runtime projects from the manifest —
// used by the resolver tests below to prove byte-identical #312 scrub sets.
const CLAUDE_CODE_DESCRIPTOR: AdapterAuthDescriptor = {
  provider: "anthropic",
  authEnforce: "always",
  authSubscription: {
    setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
    conflictEnv: ["ANTHROPIC_AUTH_TOKEN"],
    unsetEnvAdd: [
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "CLAUDE_CODE_USE_ANTHROPIC_AWS",
      "CLAUDE_CODE_USE_MANTLE",
      "CLAUDE_CODE_USE_GATEWAY",
      "ANTHROPIC_BASE_URL",
    ],
  },
}

describe("resolveSpawnDefaults", () => {
  it("passes through with no defaults and no explicit call", () => {
    const result = resolveSpawnDefaults(undefined, "hermes", {})
    expect(result).toEqual({ skills: [], options: {}, ...NO_AUTH })
  })

  it("applies global defaults when no per-adapter block matches", () => {
    const defaults: SpawnDefaultsConfig = {
      skills: ["agentproto"],
      options: { verbose: true },
    }
    const result = resolveSpawnDefaults(defaults, "hermes", {})
    expect(result).toEqual({
      skills: ["agentproto"],
      options: { verbose: true },
      ...NO_AUTH,
    })
  })

  it("unions global + per-adapter skills, and per-adapter options win on collision", () => {
    const defaults: SpawnDefaultsConfig = {
      skills: ["agentproto"],
      options: { verbose: true },
      adapters: {
        hermes: {
          skills: ["agentproto-package-scaffolding"],
          options: { verbose: false, lean: true },
        },
      },
    }
    const result = resolveSpawnDefaults(defaults, "hermes", {})
    expect(result.skills.sort()).toEqual(
      ["agentproto", "agentproto-package-scaffolding"].sort(),
    )
    expect(result.options).toEqual({ verbose: false, lean: true })
  })

  it("does not apply another adapter's per-adapter block", () => {
    const defaults: SpawnDefaultsConfig = {
      skills: ["agentproto"],
      adapters: {
        hermes: { skills: ["hermes-only"] },
      },
    }
    const result = resolveSpawnDefaults(defaults, "claude-code", {})
    expect(result.skills).toEqual(["agentproto"])
  })

  it("explicit-call options win over both global and per-adapter defaults", () => {
    const defaults: SpawnDefaultsConfig = {
      options: { verbose: true },
      adapters: { hermes: { options: { verbose: false } } },
    }
    const result = resolveSpawnDefaults(defaults, "hermes", {
      options: { verbose: "loud" },
    })
    expect(result.options).toEqual({ verbose: "loud" })
  })

  it("an explicit-call skills list REPLACES the union — it does not merge", () => {
    const defaults: SpawnDefaultsConfig = {
      skills: ["agentproto"],
      adapters: { hermes: { skills: ["hermes-only"] } },
    }
    const result = resolveSpawnDefaults(defaults, "hermes", {
      skills: ["explicit-only"],
    })
    expect(result.skills).toEqual(["explicit-only"])
  })

  it("an explicit-call EMPTY skills list is a deliberate opt-out, not a passthrough", () => {
    const defaults: SpawnDefaultsConfig = { skills: ["agentproto"] }
    const result = resolveSpawnDefaults(defaults, "hermes", { skills: [] })
    expect(result.skills).toEqual([])
  })
})

describe("resolveSpawnDefaults auth — raw material precedence", () => {
  it("surfaces `explicit: false` and nothing else when nothing is configured", () => {
    const result = resolveSpawnDefaults(undefined, "claude-code", {})
    expect(result.auth).toEqual({ explicit: false })
  })

  it("surfaces the per-adapter config mode + api key + explicit:true", () => {
    const defaults: SpawnDefaultsConfig = {
      adapters: { "claude-code": { auth: { mode: "api-key", apiKey: "sk-ant-api03-cfg" } } },
    }
    const result = resolveSpawnDefaults(defaults, "claude-code", {})
    expect(result.auth).toEqual({
      explicit: true,
      requestedMode: "api-key",
      apiKeyCredential: "sk-ant-api03-cfg",
    })
  })

  it("an explicit-call auth.mode wins over the per-adapter config mode; BOTH creds are surfaced (not collapsed to the mode)", () => {
    const defaults: SpawnDefaultsConfig = {
      adapters: {
        "claude-code": {
          auth: { mode: "api-key", apiKey: "sk-ant-api03-cfg", token: "sk-ant-oat01-cfg" },
        },
      },
    }
    const result = resolveSpawnDefaults(defaults, "claude-code", {
      auth: { mode: "subscription" },
    })
    // Mode flips to subscription; unlike the old resolver, BOTH candidate
    // credentials survive so the ordered-mode selection in resolveAuthSpec can
    // see availability before it picks.
    expect(result.auth).toEqual({
      explicit: true,
      requestedMode: "subscription",
      subscriptionCredential: "sk-ant-oat01-cfg",
      apiKeyCredential: "sk-ant-api03-cfg",
    })
  })

  it("an explicit-call credential wins over the config credential", () => {
    const defaults: SpawnDefaultsConfig = {
      adapters: { "claude-code": { auth: { mode: "subscription", token: "sk-ant-oat01-cfg" } } },
    }
    const result = resolveSpawnDefaults(defaults, "claude-code", {
      auth: { token: "sk-ant-oat01-explicit" },
    })
    expect(result.auth).toEqual({
      explicit: true,
      requestedMode: "subscription",
      subscriptionCredential: "sk-ant-oat01-explicit",
    })
  })

  it("carries the per-spawn provider pin", () => {
    const result = resolveSpawnDefaults(undefined, "opencode", {
      auth: { mode: "api-key", provider: "anthropic" },
    })
    expect(result.auth).toEqual({
      explicit: true,
      requestedMode: "api-key",
      provider: "anthropic",
    })
  })

  it("does not apply another adapter's per-adapter auth default", () => {
    const defaults: SpawnDefaultsConfig = {
      adapters: { "claude-code": { auth: { mode: "api-key", apiKey: "sk-ant-api03-cfg" } } },
    }
    const result = resolveSpawnDefaults(defaults, "hermes", {})
    expect(result.auth).toEqual({ explicit: false })
  })

  it("surfaces the config `auth.source` opt-in (Mode 3) as raw material", () => {
    const defaults: SpawnDefaultsConfig = {
      adapters: { "claude-code": { auth: { source: "claude-code-oauth" } } },
    }
    const result = resolveSpawnDefaults(defaults, "claude-code", {})
    expect(result.auth).toEqual({
      explicit: true,
      subscriptionSource: "claude-code-oauth",
    })
  })

  it("a per-spawn `auth.source` wins over the config source", () => {
    const defaults: SpawnDefaultsConfig = {
      adapters: { "claude-code": { auth: { source: "config-source" } } },
    }
    const result = resolveSpawnDefaults(defaults, "claude-code", {
      auth: { source: "claude-code-oauth" },
    })
    expect(result.auth).toEqual({
      explicit: true,
      subscriptionSource: "claude-code-oauth",
    })
  })

  it("surfaces BOTH a static token and a source when config sets both (caller decides precedence)", () => {
    const defaults: SpawnDefaultsConfig = {
      adapters: {
        "claude-code": { auth: { token: "sk-ant-oat01-cfg", source: "claude-code-oauth" } },
      },
    }
    const result = resolveSpawnDefaults(defaults, "claude-code", {})
    expect(result.auth).toEqual({
      explicit: true,
      subscriptionCredential: "sk-ant-oat01-cfg",
      subscriptionSource: "claude-code-oauth",
    })
  })
})

describe("resolveAuthSpec — provider resolution", () => {
  it("uses the adapter's FIXED provider (claude-code → anthropic)", () => {
    const r = resolveAuthSpec({
      descriptor: CLAUDE_CODE_DESCRIPTOR,
      explicit: true,
      requestedMode: "api-key",
      apiKeyConfigCredential: "sk-ant-api03-x",
    })
    expect(r?.echo.provider).toBe("anthropic")
    expect(r?.spec.setEnv).toBe("ANTHROPIC_API_KEY")
  })

  it("derives the provider from the MODEL for a by-model router, picking the right key env", () => {
    // opencode-like: no fixed provider, api-key requested, model resolves to
    // anthropic via the catalog → ANTHROPIC_API_KEY.
    const r = resolveAuthSpec({
      descriptor: {},
      model: "claude-sonnet-5",
      explicit: true,
      requestedMode: "api-key",
      apiKeyStoreCredential: "sk-ant-api03-store",
    })
    expect(r?.echo.provider).toBe("anthropic")
    expect(r?.spec.setEnv).toBe("ANTHROPIC_API_KEY")
    expect(r?.spec.credential).toBe("sk-ant-api03-store")
    expect(r?.echo.credentialSource).toBe("providers-store")
  })

  it("an UNKNOWN/free-form model with no fixed provider ⇒ no spec (ambient, never guess)", () => {
    const r = resolveAuthSpec({
      descriptor: {},
      model: "made-up-nonexistent-model-000",
      explicit: true,
      requestedMode: "api-key",
    })
    expect(r).toBeUndefined()
  })

  it("the per-spawn provider pin overrides model derivation", () => {
    const r = resolveAuthSpec({
      descriptor: {},
      model: "claude-sonnet-5",
      requestedProvider: "openrouter",
      explicit: true,
      requestedMode: "api-key",
      apiKeyConfigCredential: "sk-or-v1-x",
    })
    expect(r?.echo.provider).toBe("openrouter")
    expect(r?.spec.setEnv).toBe("OPENROUTER_API_KEY")
  })
})

describe("resolveAuthSpec — modelDerivedApiKey", () => {
  it("resolves api-key from the model when adapter declares modelDerivedApiKey", () => {
    const r = resolveAuthSpec({
      descriptor: { modelDerivedApiKey: true },
      model: "claude-sonnet-5",
      explicit: true,
      requestedMode: "api-key",
      apiKeyConfigCredential: "sk-ant-api03-x",
    })
    expect(r?.echo.provider).toBe("anthropic")
    expect(r?.spec.setEnv).toBe("ANTHROPIC_API_KEY")
    expect(r?.echo.credentialSource).toBe("explicit-config")
  })

  it("still resolves model-derived provider even without the flag (backward compatible)", () => {
    const r = resolveAuthSpec({
      descriptor: {},
      model: "claude-sonnet-5",
      explicit: true,
      requestedMode: "api-key",
      apiKeyConfigCredential: "sk-ant-api03-x",
    })
    expect(r?.echo.provider).toBe("anthropic")
    expect(r?.spec.setEnv).toBe("ANTHROPIC_API_KEY")
  })
})

describe("resolveAuthSpec — gateway route injection", () => {
  it("route.gateway = moonshot -> MOONSHOT_API_KEY + base_url + anthropic scrub", () => {
    const r = resolveAuthSpec({
      descriptor: { modelDerivedApiKey: true },
      model: "claude-sonnet-5",
      routeGateway: "moonshot",
      explicit: true,
      requestedMode: "api-key",
      apiKeyConfigCredential: "mk-test-key",
    })
    expect(r?.echo.provider).toBe("moonshot")
    expect(r?.spec.setEnv).toBe("MOONSHOT_API_KEY")
    expect(r?.spec.baseUrl).toBe("https://api.moonshot.ai/anthropic")
    expect(r?.spec.credential).toBe("mk-test-key")
    // Native Anthropic credential must not leak to the gateway host.
    expect(r?.spec.unsetEnv).toContain("ANTHROPIC_API_KEY")
    expect(r?.echo.credentialSource).toBe("explicit-config")
  })

  it("gateway route forces api-key and rejects subscription mode", () => {
    expect(() =>
      resolveAuthSpec({
        descriptor: CLAUDE_CODE_DESCRIPTOR,
        routeGateway: "moonshot",
        explicit: true,
        requestedMode: "subscription",
      }),
    ).toThrow(AuthResolutionError)
  })

  it("gateway route prefers api-key even when a subscription credential is present", () => {
    const r = resolveAuthSpec({
      descriptor: CLAUDE_CODE_DESCRIPTOR,
      routeGateway: "moonshot",
      explicit: true,
      subscriptionCredential: "sk-ant-oat01-sub",
      apiKeyConfigCredential: "mk-test-key",
    })
    expect(r?.echo.authMode).toBe("api-key")
    expect(r?.spec.setEnv).toBe("MOONSHOT_API_KEY")
    expect(r?.spec.unsetEnv).toContain("ANTHROPIC_API_KEY")
    expect(r?.spec.unsetEnv).toContain("CLAUDE_CODE_OAUTH_TOKEN")
  })

  it("unknown routeGateway falls back to model-derived provider", () => {
    const r = resolveAuthSpec({
      descriptor: { modelDerivedApiKey: true },
      model: "claude-sonnet-5",
      routeGateway: "not-a-real-gateway",
      explicit: true,
      requestedMode: "api-key",
      apiKeyConfigCredential: "sk-ant-api03-x",
    })
    expect(r?.echo.provider).toBe("anthropic")
    expect(r?.spec.setEnv).toBe("ANTHROPIC_API_KEY")
    expect(r?.spec.baseUrl).toBeUndefined()
  })
})

describe("resolveAuthSpec — mode validation + ordered preference", () => {
  it("subscription requested on an adapter with no authSubscription ⇒ unsupported_auth_mode", () => {
    expect(() =>
      resolveAuthSpec({
        descriptor: { provider: "openai" }, // codex-like, no authSubscription
        explicit: true,
        requestedMode: "subscription",
      }),
    ).toThrow(AuthResolutionError)
    try {
      resolveAuthSpec({
        descriptor: { provider: "openai" },
        explicit: true,
        requestedMode: "subscription",
      })
    } catch (err) {
      expect((err as AuthResolutionError).code).toBe("unsupported_auth_mode")
    }
  })

  it("ordered-mode: a subscription credential present + no explicit mode ⇒ picks SUBSCRIPTION, not api-key", () => {
    const r = resolveAuthSpec({
      descriptor: CLAUDE_CODE_DESCRIPTOR,
      explicit: true,
      // both creds available, no requestedMode → ordered preference
      subscriptionCredential: "sk-ant-oat01-sub",
      apiKeyConfigCredential: "sk-ant-api03-key",
    })
    expect(r?.echo.authMode).toBe("subscription")
    expect(r?.spec.setEnv).toBe("CLAUDE_CODE_OAUTH_TOKEN")
    expect(r?.spec.credential).toBe("sk-ant-oat01-sub")
    // The api key is NOT set — it's scrubbed.
    expect(r?.spec.unsetEnv).toContain("ANTHROPIC_API_KEY")
  })

  it("ordered-mode: only an api-key credential present ⇒ picks api-key", () => {
    const r = resolveAuthSpec({
      descriptor: CLAUDE_CODE_DESCRIPTOR,
      explicit: true,
      apiKeyConfigCredential: "sk-ant-api03-key",
    })
    expect(r?.echo.authMode).toBe("api-key")
  })

  it("a single-provider adapter with no creds still resolves (mode api-key, no credential ⇒ driver fail-fast)", () => {
    const r = resolveAuthSpec({
      descriptor: { provider: "openai" },
      explicit: true,
      requestedMode: "api-key",
    })
    expect(r?.spec.mode).toBe("api-key")
    expect(r?.spec.credential).toBeUndefined()
    expect(r?.echo.credentialSource).toBe("none")
    // Single-credential provider → empty scrub.
    expect(r?.spec.unsetEnv).toEqual([])
    // An explicit requestedMode is a real signal — never the fallback flag.
    expect(r?.spec.neitherConfigured).toBeUndefined()
  })
})

// The codex file-based (external) subscription descriptor — no setEnv (the CLI
// reads ~/.codex/auth.json itself), external:true, CODEX_API_KEY as the sibling
// api-key var to scrub alongside the provider var OPENAI_API_KEY.
const CODEX_EXTERNAL_DESCRIPTOR: AdapterAuthDescriptor = {
  provider: "openai",
  authSubscription: {
    external: true,
    conflictEnv: ["CODEX_API_KEY"],
  },
}

describe("resolveAuthSpec — file-based (external) subscription", () => {
  it("verified external login ⇒ subscription, injects NOTHING, scrubs the api-key vars", () => {
    const r = resolveAuthSpec({
      descriptor: CODEX_EXTERNAL_DESCRIPTOR,
      explicit: true,
      requestedMode: "subscription",
      externalSubscriptionVerified: true,
    })
    expect(r?.spec.mode).toBe("subscription")
    expect(r?.spec.externalCredential).toBe(true)
    // Money-safety: no credential, no env var set.
    expect(r?.spec.credential).toBeUndefined()
    expect(r?.spec.setEnv).toBe("")
    // Both the provider api-key var and the sibling are scrubbed.
    expect(r?.spec.unsetEnv).toEqual(
      expect.arrayContaining(["OPENAI_API_KEY", "CODEX_API_KEY"]),
    )
    // Observable echo records the local login (non-secret marker, no fingerprint
    // of a real secret since none was injected).
    expect(r?.echo.credentialSource).toBe("cli-local-login")
    expect(r?.echo.authMode).toBe("subscription")
    expect(r?.echo.fingerprint).toBe("subscription · local-login")
  })

  it("ordered preference picks the external subscription when the login is verified", () => {
    const r = resolveAuthSpec({
      descriptor: CODEX_EXTERNAL_DESCRIPTOR,
      explicit: true,
      // no requestedMode → ordered preference; verified login counts as available
      externalSubscriptionVerified: true,
    })
    expect(r?.spec.mode).toBe("subscription")
    expect(r?.spec.externalCredential).toBe(true)
    expect(r?.spec.neitherConfigured).toBeUndefined()
  })

  it("unverified/unconfigured external adapter ⇒ neitherConfigured, echo stays honest as none", () => {
    const r = resolveAuthSpec({
      descriptor: CODEX_EXTERNAL_DESCRIPTOR,
      explicit: false,
    })
    // Ordered preference still lands on subscription (the only sub-supporting
    // mode) but flags it as an arbitrary pick — the driver won't engage it
    // (when-configured + not explicit ⇒ ambient).
    expect(r?.spec.mode).toBe("subscription")
    expect(r?.spec.neitherConfigured).toBe(true)
    expect(r?.echo.credentialSource).toBe("none")
    // No secret was used, so no fingerprint marker.
    expect(r?.echo.fingerprint).toBeUndefined()
  })

  it("api-key requested on an external adapter still resolves the api-key path", () => {
    const r = resolveAuthSpec({
      descriptor: CODEX_EXTERNAL_DESCRIPTOR,
      explicit: true,
      requestedMode: "api-key",
      apiKeyConfigCredential: "sk-openai-key",
    })
    expect(r?.spec.mode).toBe("api-key")
    expect(r?.spec.externalCredential).toBeUndefined()
    expect(r?.spec.setEnv).toBe("OPENAI_API_KEY")
    expect(r?.spec.credential).toBe("sk-openai-key")
  })
})

// The gemini file-based (external) subscription descriptor — the same primitive
// as codex, but provider "google" (⇒ provider api-key var
// GOOGLE_GENERATIVE_AI_API_KEY scrubbed automatically) and TWO conflictEnv
// siblings: GEMINI_API_KEY and GOOGLE_API_KEY. Both matter because an env API
// key OVERRIDES the OAuth login in Google's precedence, so all three must be
// scrubbed for the login to win.
const GEMINI_EXTERNAL_DESCRIPTOR: AdapterAuthDescriptor = {
  provider: "google",
  authSubscription: {
    external: true,
    conflictEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  },
}

describe("resolveAuthSpec — gemini file-based (external) subscription", () => {
  it("verified external login ⇒ subscription, injects NOTHING, scrubs ALL THREE gemini api-key vars", () => {
    const r = resolveAuthSpec({
      descriptor: GEMINI_EXTERNAL_DESCRIPTOR,
      explicit: true,
      requestedMode: "subscription",
      externalSubscriptionVerified: true,
    })
    expect(r?.spec.mode).toBe("subscription")
    expect(r?.spec.externalCredential).toBe(true)
    // Money-safety: no credential, no env var set.
    expect(r?.spec.credential).toBeUndefined()
    expect(r?.spec.setEnv).toBe("")
    // The provider api-key var PLUS both siblings — the whole set the Gemini CLI
    // honors — is scrubbed, so a stray key can't flip billing.
    expect(r?.spec.unsetEnv).toEqual(
      expect.arrayContaining([
        "GOOGLE_GENERATIVE_AI_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
      ]),
    )
    expect(r?.echo.credentialSource).toBe("cli-local-login")
    expect(r?.echo.authMode).toBe("subscription")
    expect(r?.echo.fingerprint).toBe("subscription · local-login")
  })

  it("unverified/unconfigured gemini spawn ⇒ neitherConfigured, echo stays honest as none", () => {
    const r = resolveAuthSpec({
      descriptor: GEMINI_EXTERNAL_DESCRIPTOR,
      explicit: false,
    })
    expect(r?.spec.mode).toBe("subscription")
    expect(r?.spec.neitherConfigured).toBe(true)
    expect(r?.echo.credentialSource).toBe("none")
    expect(r?.echo.fingerprint).toBeUndefined()
  })

  it("api-key requested on gemini still resolves the api-key path (sets the provider var)", () => {
    const r = resolveAuthSpec({
      descriptor: GEMINI_EXTERNAL_DESCRIPTOR,
      explicit: true,
      requestedMode: "api-key",
      apiKeyConfigCredential: "AIza-key",
    })
    expect(r?.spec.mode).toBe("api-key")
    expect(r?.spec.externalCredential).toBeUndefined()
    expect(r?.spec.setEnv).toBe("GOOGLE_GENERATIVE_AI_API_KEY")
    expect(r?.spec.credential).toBe("AIza-key")
  })
})

// The money bug (scope correction): an api-key-only, zero-credential user was
// silently resolved to "subscription" (preference[0]) and told to buy one —
// the api-key advice sat in an unreachable else branch. `neitherConfigured`
// is the fix: it flags "mode above is an arbitrary pick, not a real signal"
// so the driver's fail-fast message can enumerate BOTH paths honestly.
describe("resolveAuthSpec — neitherConfigured (the money bug)", () => {
  it("neither subscription nor api-key available ⇒ falls back to preference[0] but flags neitherConfigured", () => {
    const r = resolveAuthSpec({
      descriptor: CLAUDE_CODE_DESCRIPTOR,
      explicit: false,
    })
    // preference[0] for an adapter that supports subscription — but this is
    // now a KNOWN-arbitrary pick, not a real signal.
    expect(r?.spec.mode).toBe("subscription")
    expect(r?.spec.credential).toBeUndefined()
    expect(r?.spec.neitherConfigured).toBe(true)
  })

  it("an adapter with no authSubscription and no api-key credential ⇒ neitherConfigured true (mode still api-key, the only option)", () => {
    const r = resolveAuthSpec({
      descriptor: { provider: "openai" }, // codex-like, no authSubscription
      explicit: false,
    })
    expect(r?.spec.mode).toBe("api-key")
    expect(r?.spec.neitherConfigured).toBe(true)
  })

  it("a subscription credential IS available ⇒ subscription-first preference unaffected, neitherConfigured unset", () => {
    const r = resolveAuthSpec({
      descriptor: CLAUDE_CODE_DESCRIPTOR,
      explicit: true,
      subscriptionCredential: "sk-ant-oat01-sub",
    })
    expect(r?.spec.mode).toBe("subscription")
    expect(r?.spec.credential).toBe("sk-ant-oat01-sub")
    expect(r?.spec.neitherConfigured).toBeUndefined()
  })

  it("only an api-key credential is available ⇒ neitherConfigured unset", () => {
    const r = resolveAuthSpec({
      descriptor: CLAUDE_CODE_DESCRIPTOR,
      explicit: true,
      apiKeyConfigCredential: "sk-ant-api03-key",
    })
    expect(r?.spec.mode).toBe("api-key")
    expect(r?.spec.neitherConfigured).toBeUndefined()
  })

  it("an explicit requestedMode with no credential is a real signal, never neitherConfigured — even with nothing else configured", () => {
    const r = resolveAuthSpec({
      descriptor: CLAUDE_CODE_DESCRIPTOR,
      explicit: true,
      requestedMode: "subscription",
    })
    expect(r?.spec.mode).toBe("subscription")
    expect(r?.spec.credential).toBeUndefined()
    expect(r?.spec.neitherConfigured).toBeUndefined()
  })
})

describe("resolveAuthSpec — claude-code byte-identical scrub sets (#312)", () => {
  it("subscription: SETS CLAUDE_CODE_OAUTH_TOKEN, scrubs exactly #312's subscription set", () => {
    const r = resolveAuthSpec({
      descriptor: CLAUDE_CODE_DESCRIPTOR,
      explicit: true,
      requestedMode: "subscription",
      subscriptionCredential: "sk-ant-oat01-x",
    })
    expect(r?.spec.setEnv).toBe("CLAUDE_CODE_OAUTH_TOKEN")
    expect(new Set(r?.spec.unsetEnv)).toEqual(
      new Set([
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "CLAUDE_CODE_USE_ANTHROPIC_AWS",
        "CLAUDE_CODE_USE_MANTLE",
        "CLAUDE_CODE_USE_GATEWAY",
        "ANTHROPIC_BASE_URL",
      ]),
    )
    // never scrubs the var it sets
    expect(r?.spec.unsetEnv).not.toContain("CLAUDE_CODE_OAUTH_TOKEN")
  })

  it("api-key: SETS ANTHROPIC_API_KEY, scrubs exactly #312's api-key set (no gateway hygiene)", () => {
    const r = resolveAuthSpec({
      descriptor: CLAUDE_CODE_DESCRIPTOR,
      explicit: true,
      requestedMode: "api-key",
      apiKeyConfigCredential: "sk-ant-api03-x",
    })
    expect(r?.spec.setEnv).toBe("ANTHROPIC_API_KEY")
    expect(new Set(r?.spec.unsetEnv)).toEqual(
      new Set(["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]),
    )
    // api-key mode must NOT scrub the cloud toggles / base_url (deliberate:
    // an api-key + Bedrock combination stays valid).
    expect(r?.spec.unsetEnv).not.toContain("CLAUDE_CODE_USE_BEDROCK")
    expect(r?.spec.unsetEnv).not.toContain("ANTHROPIC_BASE_URL")
  })

  it("carries the enforce + explicit signals through to the driver spec", () => {
    const r = resolveAuthSpec({
      descriptor: CLAUDE_CODE_DESCRIPTOR,
      explicit: false,
      requestedMode: "subscription",
    })
    expect(r?.spec.enforce).toBe("always")
    expect(r?.spec.explicit).toBe(false)
    expect(r?.spec.credential).toBeUndefined() // ⇒ driver fail-fast on engage
  })
})

describe("resolveAuthSpec — subscriptionCredentialSource label (Mode 3)", () => {
  it("echoes credentialSource:claude-code-oauth when the caller labels the subscription credential", () => {
    const r = resolveAuthSpec({
      descriptor: CLAUDE_CODE_DESCRIPTOR,
      explicit: true,
      requestedMode: "subscription",
      subscriptionCredential: "sk-ant-oat01-fresh",
      subscriptionCredentialSource: "claude-code-oauth",
    })
    expect(r?.echo.authMode).toBe("subscription")
    expect(r?.echo.credentialSource).toBe("claude-code-oauth")
    expect(r?.spec.credential).toBe("sk-ant-oat01-fresh")
    // The label NEVER alters the mechanical spec — same setEnv/scrub as any
    // subscription resolution.
    expect(r?.spec.setEnv).toBe("CLAUDE_CODE_OAUTH_TOKEN")
  })

  it("defaults the subscription origin to explicit-config when no label is given (Mode 2 unchanged)", () => {
    const r = resolveAuthSpec({
      descriptor: CLAUDE_CODE_DESCRIPTOR,
      explicit: true,
      requestedMode: "subscription",
      subscriptionCredential: "sk-ant-oat01-static",
    })
    expect(r?.echo.credentialSource).toBe("explicit-config")
  })

  it("never labels a MISSING subscription credential — stays `none`", () => {
    const r = resolveAuthSpec({
      descriptor: CLAUDE_CODE_DESCRIPTOR,
      explicit: true,
      requestedMode: "subscription",
      // no credential, but a stray label — must not fabricate a source
      subscriptionCredentialSource: "claude-code-oauth",
    })
    expect(r?.spec.credential).toBeUndefined()
    expect(r?.echo.credentialSource).toBe("none")
  })
})

describe("resolveSubscriptionCredential — precedence (SPEC §2, Mode 3)", () => {
  it("(a) an explicit per-spawn token WINS over a source — the recipe is never consulted", async () => {
    const recipe = vi.fn(async () => "sk-ant-oat01-fresh")
    const r = await resolveSubscriptionCredential(
      {
        explicitToken: "sk-ant-oat01-explicit",
        source: CLAUDE_CODE_OAUTH_SOURCE,
        fallbackStaticToken: "sk-ant-oat01-cfg",
      },
      recipe,
    )
    expect(r).toEqual({ credential: "sk-ant-oat01-explicit", source: "explicit-config" })
    expect(recipe).not.toHaveBeenCalled()
  })

  it("(b) source:claude-code-oauth resolves FRESH via the injected recipe → claude-code-oauth origin", async () => {
    const recipe = vi.fn(async (id: string) => {
      expect(id).toBe(CLAUDE_CODE_OAUTH_SOURCE)
      return "  sk-ant-oat01-fresh-from-keychain  " // resolver is expected to hand back trimmed
    })
    const r = await resolveSubscriptionCredential(
      { source: CLAUDE_CODE_OAUTH_SOURCE, fallbackStaticToken: "sk-ant-oat01-cfg" },
      recipe,
    )
    expect(r.source).toBe("claude-code-oauth")
    expect(r.credential).toBe("  sk-ant-oat01-fresh-from-keychain  ")
    expect(recipe).toHaveBeenCalledOnce()
  })

  it("(b) source WINS over a config static token", async () => {
    const recipe = vi.fn(async () => "sk-ant-oat01-fresh")
    const r = await resolveSubscriptionCredential(
      { source: CLAUDE_CODE_OAUTH_SOURCE, fallbackStaticToken: "sk-ant-oat01-cfg" },
      recipe,
    )
    expect(r.credential).toBe("sk-ant-oat01-fresh")
    expect(r.source).toBe("claude-code-oauth")
  })

  it("(c) no source ⇒ unchanged static behavior (config token, explicit-config origin)", async () => {
    const recipe = vi.fn(async () => "unused")
    const r = await resolveSubscriptionCredential(
      { fallbackStaticToken: "sk-ant-oat01-cfg" },
      recipe,
    )
    expect(r).toEqual({ credential: "sk-ant-oat01-cfg", source: "explicit-config" })
    expect(recipe).not.toHaveBeenCalled()
  })

  it("(d) source set but the recipe RESOLVES TO NOTHING ⇒ clear, loud error (never a silent fallthrough)", async () => {
    const recipe = vi.fn(async () => {
      throw new Error("keychain item 'Claude Code-credentials' not found")
    })
    await expect(
      resolveSubscriptionCredential(
        { source: CLAUDE_CODE_OAUTH_SOURCE, fallbackStaticToken: "sk-ant-oat01-cfg" },
        recipe,
      ),
    ).rejects.toMatchObject({
      name: "SubscriptionSourceError",
      code: "auth_source_unresolved",
    })
  })

  it("(d') source set but the recipe returns an EMPTY string ⇒ same loud error", async () => {
    const recipe = vi.fn(async () => "")
    await expect(
      resolveSubscriptionCredential({ source: CLAUDE_CODE_OAUTH_SOURCE }, recipe),
    ).rejects.toBeInstanceOf(SubscriptionSourceError)
  })

  it("an UNKNOWN source value fails LOUD as unsupported_auth_source (recipe never consulted)", async () => {
    const recipe = vi.fn(async () => "unused")
    await expect(
      resolveSubscriptionCredential({ source: "some-other-source" }, recipe),
    ).rejects.toMatchObject({
      name: "SubscriptionSourceError",
      code: "unsupported_auth_source",
    })
    expect(recipe).not.toHaveBeenCalled()
  })

  it("nothing configured ⇒ empty resolution (driver fail-fast owns missing_auth_credential)", async () => {
    const recipe = vi.fn(async () => "unused")
    const r = await resolveSubscriptionCredential({}, recipe)
    expect(r).toEqual({})
    expect(recipe).not.toHaveBeenCalled()
  })
})

describe("credentialFingerprint — by key shape (DECISION 6)", () => {
  it("never includes the raw credential", () => {
    const secret = "sk-ant-oat01-VERY-SECRET-TOKEN-DO-NOT-LEAK-3f9c"
    const fp = credentialFingerprint("subscription", secret)
    expect(fp).not.toContain(secret)
    expect(fp).not.toContain("VERY-SECRET-TOKEN-DO-NOT-LEAK")
  })

  it("matches the anthropic OAuth shape (sk-ant-oat)", () => {
    expect(credentialFingerprint("subscription", "sk-ant-oat01-abcdef3f9c")).toBe(
      "subscription · sk-ant-oat…3f9c",
    )
  })

  it("matches the anthropic api-key shape (sk-ant-api)", () => {
    expect(credentialFingerprint("api-key", "sk-ant-api03-abcdef7b21")).toBe(
      "api-key · sk-ant-api…7b21",
    )
  })

  it("matches the OpenRouter shape (sk-or-v1-)", () => {
    expect(credentialFingerprint("api-key", "sk-or-v1-abcdef0000wxyz")).toBe(
      "api-key · sk-or-v1-…wxyz",
    )
  })

  it("matches the OpenAI project-key shape (sk-proj-)", () => {
    expect(credentialFingerprint("api-key", "sk-proj-abcdef00001234")).toBe(
      "api-key · sk-proj-…1234",
    )
  })

  it("falls back to `<mode> · …<last4>` for an unrecognized shape", () => {
    expect(credentialFingerprint("api-key", "totally-custom-key-9999")).toBe(
      "api-key · …9999",
    )
  })

  it("only ever surfaces the last 4 characters — never the middle", () => {
    const fp = credentialFingerprint("api-key", "sk-ant-api03-MIDDLE-SECRET-abcd")
    expect(fp).not.toContain("MIDDLE-SECRET")
    expect(fp.endsWith("abcd")).toBe(true)
  })
})

describe("normalizeSkillsOption", () => {
  it("joins skills into options.skills when the adapter declares a string-typed option", () => {
    const result = normalizeSkillsOption(
      ["a", "b"],
      {},
      [{ id: "skills", type: "string" }],
    )
    expect(result).toEqual({ skills: "a,b" })
  })

  it("is a no-op when the adapter declares no skills option (e.g. claude-code)", () => {
    const result = normalizeSkillsOption(["a", "b"], {}, [])
    expect(result).toEqual({})
  })

  it("is a no-op when declaredOptions is undefined", () => {
    const result = normalizeSkillsOption(["a", "b"], {}, undefined)
    expect(result).toEqual({})
  })

  it("is a no-op when skills is empty", () => {
    const result = normalizeSkillsOption([], { other: 1 }, [
      { id: "skills", type: "string" },
    ])
    expect(result).toEqual({ other: 1 })
  })

  it("respects an options.skills already set explicitly, without overwriting it", () => {
    const result = normalizeSkillsOption(
      ["a", "b"],
      { skills: "manually-set" },
      [{ id: "skills", type: "string" }],
    )
    expect(result).toEqual({ skills: "manually-set" })
  })

  it("does not guess a shape for a non-string declared skills option", () => {
    const result = normalizeSkillsOption(["a", "b"], {}, [
      { id: "skills", type: "enum" },
    ])
    expect(result).toEqual({})
  })
})
