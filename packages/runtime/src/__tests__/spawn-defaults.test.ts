/**
 * Unit coverage for the pure `defaults` resolver (spawn-defaults.ts) —
 * config.json's global/per-adapter `skills`+`options` merged against an
 * explicit `agent_start` call, and the adapter-shape folding of `skills`
 * into `options.skills`. No fs, no adapters — see session-spawn.test.ts
 * for the wiring into `spawnAgentSession`.
 */

import { describe, it, expect } from "vitest"
import {
  resolveSpawnDefaults,
  normalizeSkillsOption,
  type SpawnDefaultsConfig,
} from "../spawn-defaults.js"

describe("resolveSpawnDefaults", () => {
  it("passes through with no defaults and no explicit call", () => {
    const result = resolveSpawnDefaults(undefined, "hermes", {})
    expect(result).toEqual({ skills: [], options: {} })
  })

  it("applies global defaults when no per-adapter block matches", () => {
    const defaults: SpawnDefaultsConfig = {
      skills: ["agentproto"],
      options: { verbose: true },
    }
    const result = resolveSpawnDefaults(defaults, "hermes", {})
    expect(result).toEqual({ skills: ["agentproto"], options: { verbose: true } })
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
