import { describe, it, expect } from "vitest"
import {
  ANTHROPIC_GATEWAY_PRESETS,
  anthropicGatewayPresetList,
  getAnthropicGatewayPreset,
} from "../anthropic-gateways.js"
import type { ProviderPreset } from "../types.js"

describe("ANTHROPIC_GATEWAY_PRESETS", () => {
  it("exposes moonshot and openrouter", () => {
    expect(Object.keys(ANTHROPIC_GATEWAY_PRESETS).sort()).toEqual([
      "moonshot",
      "openrouter",
    ])
  })

  for (const preset of anthropicGatewayPresetList) {
    describe(`preset "${preset.id}"`, () => {
      it("has a stable id matching its registry key", () => {
        expect(ANTHROPIC_GATEWAY_PRESETS[preset.id as keyof typeof ANTHROPIC_GATEWAY_PRESETS]).toBeDefined()
        expect(ANTHROPIC_GATEWAY_PRESETS[preset.id as keyof typeof ANTHROPIC_GATEWAY_PRESETS].id).toBe(preset.id)
      })

      it("has the required catalog fields with sane shapes", () => {
        expect(preset.label).toBeTruthy()
        expect(preset.description).toBeTruthy()
        expect(preset.baseUrl).toMatch(/^https:\/\//)
        expect(preset.keyEnv).toMatch(/_API_KEY$/)
        expect(preset.schemaFlavor).toBe("anthropic")
      })

      it("scrubs the ambient ANTHROPIC_API_KEY so it can't leak to the gateway", () => {
        expect(preset.scrubEnv).toContain("ANTHROPIC_API_KEY")
      })

      it("satisfies the ProviderPreset type (compile-time shape guard)", () => {
        const _check: ProviderPreset = preset
        expect(_check).toBe(preset)
      })
    })
  }

  it("moonshot pins the conventional default model", () => {
    expect(getAnthropicGatewayPreset("moonshot").defaultModel).toBe(
      "kimi-k2.7-code"
    )
  })

  it("openrouter ships no pinned default model (operator picks via model option)", () => {
    expect(getAnthropicGatewayPreset("openrouter").defaultModel).toBeUndefined()
  })

  it("moonshot and openrouter point at distinct base URLs", () => {
    const urls = anthropicGatewayPresetList.map((p) => p.baseUrl)
    expect(new Set(urls).size).toBe(urls.length)
  })
})

describe("getAnthropicGatewayPreset", () => {
  it("returns the preset for a known id", () => {
    expect(getAnthropicGatewayPreset("moonshot").id).toBe("moonshot")
  })

  it("throws on an unknown id (loud failure at load, not a silent no-baseUrl mode)", () => {
    expect(() =>
      getAnthropicGatewayPreset("litellm" as never)
    ).toThrow(/Unknown Anthropic gateway preset/)
  })
})
