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
  type SpawnDefaultsConfig,
} from "../spawn-defaults.js"

const NO_AUTH = { auth: { mode: "subscription" as const } }

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

describe("resolveSpawnDefaults auth — mode + credential precedence", () => {
  it("defaults to subscription with no credential when nothing is configured", () => {
    const result = resolveSpawnDefaults(undefined, "claude-code", {})
    expect(result.auth).toEqual({ mode: "subscription" })
  })

  it("falls through to defaults.adapters.<slug>.auth.mode when the call omits it", () => {
    const defaults: SpawnDefaultsConfig = {
      adapters: { "claude-code": { auth: { mode: "api-key", apiKey: "sk-ant-api03-cfg" } } },
    }
    const result = resolveSpawnDefaults(defaults, "claude-code", {})
    expect(result.auth).toEqual({ mode: "api-key", credential: "sk-ant-api03-cfg" })
  })

  it("an explicit-call auth.mode wins over the per-adapter config default", () => {
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
    // Mode flips to subscription, and the CREDENTIAL follows the resolved
    // mode — it falls back to the config's token (not apiKey), proving
    // credential resolution isn't unioned across modes.
    expect(result.auth).toEqual({ mode: "subscription", credential: "sk-ant-oat01-cfg" })
  })

  it("an explicit-call credential wins over the config credential for the same mode", () => {
    const defaults: SpawnDefaultsConfig = {
      adapters: { "claude-code": { auth: { mode: "subscription", token: "sk-ant-oat01-cfg" } } },
    }
    const result = resolveSpawnDefaults(defaults, "claude-code", {
      auth: { token: "sk-ant-oat01-explicit" },
    })
    expect(result.auth).toEqual({ mode: "subscription", credential: "sk-ant-oat01-explicit" })
  })

  it("does not apply another adapter's per-adapter auth default", () => {
    const defaults: SpawnDefaultsConfig = {
      adapters: { "claude-code": { auth: { mode: "api-key", apiKey: "sk-ant-api03-cfg" } } },
    }
    const result = resolveSpawnDefaults(defaults, "hermes", {})
    expect(result.auth).toEqual({ mode: "subscription" })
  })

  it("a subscription-mode spawn never sees a configured apiKey as its credential", () => {
    const defaults: SpawnDefaultsConfig = {
      adapters: { "claude-code": { auth: { apiKey: "sk-ant-api03-cfg" } } },
    }
    const result = resolveSpawnDefaults(defaults, "claude-code", {})
    expect(result.auth).toEqual({ mode: "subscription" })
  })
})

describe("credentialFingerprint", () => {
  it("never includes the raw credential", () => {
    const secret = "sk-ant-oat01-VERY-SECRET-TOKEN-DO-NOT-LEAK-3f9c"
    const fp = credentialFingerprint("subscription", secret)
    expect(fp).not.toContain(secret)
    expect(fp).not.toContain("VERY-SECRET-TOKEN-DO-NOT-LEAK")
  })

  it("formats subscription as '<mode> · sk-ant-oat…<last4>'", () => {
    expect(credentialFingerprint("subscription", "sk-ant-oat01-abcdef3f9c")).toBe(
      "subscription · sk-ant-oat…3f9c",
    )
  })

  it("formats api-key as '<mode> · sk-ant-api…<last4>'", () => {
    expect(credentialFingerprint("api-key", "sk-ant-api03-abcdef7b21")).toBe(
      "api-key · sk-ant-api…7b21",
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
