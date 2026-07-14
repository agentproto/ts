/**
 * Unit coverage for the pure `defaults` resolver (spawn-defaults.ts) —
 * config.json's global/per-adapter `skills`+`options`+`auth` merged against
 * an explicit `agent_start` call, and the adapter-shape folding of `skills`
 * into `options.skills`. No fs, no adapters — see session-spawn.test.ts
 * for the wiring into `spawnAgentSession`.
 */

import { describe, it, expect } from "vitest"
import {
  resolveSpawnDefaults,
  normalizeSkillsOption,
  credentialFingerprint,
  resolveAuthSpec,
  AuthResolutionError,
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
