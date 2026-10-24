import { describe, expect, it } from "vitest"
import type { ModelList, ModelListSource } from "@agentproto/model-catalog/lists"
import {
  defaultPresetFor,
  presetAxes,
  presetChain,
  resolveSessionConfig,
  SessionPresetResolutionError,
  type HarnessPresetOverlay,
} from "../session-preset-resolver.js"
import { checkModelPolicy } from "../model-policy.js"
import type { UserPreset } from "../user-presets.js"

function preset(over: Omit<UserPreset, "label"> & { label?: string }): UserPreset {
  return { label: over.id, ...over }
}

describe("presetChain", () => {
  it("applies extends left to right, then the preset itself", () => {
    const presets = [
      preset({ id: "a", model: "a-model" }),
      preset({ id: "b", model: "b-model", effort: "low" }),
      preset({ id: "leaf", extends: ["a", "b"], effort: "high" }),
    ]
    expect(presetChain("leaf", presets).map(p => p.id)).toEqual(["a", "b", "leaf"])

    const resolved = resolveSessionConfig({ presets, presetId: "leaf" })
    expect(resolved.config.model).toBe("b-model")
    expect(resolved.config.effort).toBe("high")
    expect(resolved.layers.model).toBe("preset:b")
    expect(resolved.layers.effort).toBe("preset:leaf")
  })

  it("rejects a cycle", () => {
    const presets = [
      preset({ id: "a", extends: ["b"] }),
      preset({ id: "b", extends: ["a"] }),
    ]
    expect(() => presetChain("a", presets)).toThrow(SessionPresetResolutionError)
    try {
      presetChain("a", presets)
    } catch (err) {
      expect((err as SessionPresetResolutionError).code).toBe("extends_cycle")
    }
  })

  it("rejects a missing extends target", () => {
    const presets = [preset({ id: "a", extends: ["ghost"] })]
    try {
      presetChain("a", presets)
      throw new Error("expected failure")
    } catch (err) {
      expect(err).toBeInstanceOf(SessionPresetResolutionError)
      expect((err as SessionPresetResolutionError).code).toBe("unknown_extends")
      expect((err as Error).message).toContain("ghost")
    }
  })
})

describe("resolveSessionConfig precedence", () => {
  const harnessPreset: HarnessPresetOverlay = {
    id: "hm-cheap",
    access: { profileRef: "harness-profile" },
    model: "harness-model",
    turnRetry: { on: ["rate-limit"] },
  }
  const presets = [
    preset({
      id: "default",
      defaultFor: "hermes",
      model: "default-model",
      access: { profileRef: "default-profile" },
      effort: "low",
    }),
    preset({ id: "named", model: "named-model", effort: "medium" }),
  ]

  it("request beats named preset beats defaultFor presets beats the harness preset default", () => {
    const resolved = resolveSessionConfig({
      presets,
      harness: "hermes",
      presetId: "named",
      harnessPreset,
      request: { model: "request-model" },
    })
    expect(resolved.config.model).toBe("request-model")
    expect(resolved.layers.model).toBe("request")
    // Named preset's effort outranks the defaultFor preset's.
    expect(resolved.config.effort).toBe("medium")
    expect(resolved.layers.effort).toBe("preset:named")
    // The defaultFor preset fills an axis the named preset never touched,
    // above the legacy harness preset.
    expect(resolved.config.access).toEqual({ profileRef: "default-profile" })
    expect(resolved.layers.access).toBe("preset-default:default")
    // The harness preset is the lowest layer.
    const onlyHarness = resolveSessionConfig({ harness: "hermes", harnessPreset })
    expect(onlyHarness.config.model).toBe("harness-model")
    expect(onlyHarness.layers.model).toBe("harness-preset")
  })

  it("applies the defaultFor preset when the request names no preset", () => {
    const resolved = resolveSessionConfig({
      presets,
      harness: "hermes",
      harnessPreset,
    })
    expect(resolved.config.model).toBe("default-model")
    expect(resolved.layers.model).toBe("preset-default:default")
  })

  it("unions tags and merges options key by key", () => {
    const tagged = [
      preset({ id: "base", tags: ["a", "b"], options: { x: 1, shared: "base" } }),
      preset({ id: "top", extends: ["base"], tags: ["b", "c"], options: { y: 2, shared: "top" } }),
    ]
    const resolved = resolveSessionConfig({ presets: tagged, presetId: "top" })
    expect(resolved.config.tags).toEqual(["a", "b", "c"])
    expect(resolved.config.options).toEqual({ x: 1, y: 2, shared: "top" })
    expect(resolved.layers.tags).toBe("preset:top")
    expect(resolved.layers.options).toBe("preset:top")
  })

  it("finds a defaultFor preset by harness", () => {
    expect(defaultPresetFor("hermes", presets)?.id).toBe("default")
    expect(defaultPresetFor("codex", presets)).toBeUndefined()
  })
})

describe("flat fields vs nested config", () => {
  it("lets a flat preset field win over the same axis in config", () => {
    const raw = preset({
      id: "mixed",
      model: "flat-model",
      config: { model: "nested-model", effort: "low" },
    })
    const axes = presetAxes(raw)
    expect(axes.model).toBe("flat-model")
    expect(axes.effort).toBe("low")

    const resolved = resolveSessionConfig({ presets: [raw], presetId: "mixed" })
    expect(resolved.config.model).toBe("flat-model")
    expect(resolved.config.effort).toBe("low")
  })
})

describe("policy composition", () => {
  const LISTS: Record<string, ModelList> = {
    request: { id: "request", ids: ["acme/allowed", "acme/blocked"] },
    blocked: { id: "blocked", ids: ["acme/blocked"] },
  }
  const src: ModelListSource = { get: id => LISTS[id] }

  it("keeps both the preset's block and the request's allow in force", () => {
    const presets = [preset({ id: "p", modelPolicy: { block: ["blocked"] } })]
    const resolved = resolveSessionConfig({
      presets,
      presetId: "p",
      request: { modelPolicy: { allow: ["request"] } },
    })
    expect(resolved.layers.modelPolicy).toBe("request")

    expect(checkModelPolicy("acme/allowed", resolved.config.modelPolicy, src)).toEqual({ ok: true })
    const refused = checkModelPolicy("acme/blocked", resolved.config.modelPolicy, src)
    expect(refused).toMatchObject({ ok: false, code: "model_blocked" })
  })

  it("still keeps the request's allow restriction when the preset only blocks", () => {
    const presets = [preset({ id: "p", modelPolicy: { block: ["blocked"] } })]
    const resolved = resolveSessionConfig({
      presets,
      presetId: "p",
      request: { modelPolicy: { allow: ["request"] } },
    })
    expect(
      checkModelPolicy("other/not-in-allow", resolved.config.modelPolicy, src),
    ).toMatchObject({ ok: false, code: "model_not_allowed" })
  })
})
