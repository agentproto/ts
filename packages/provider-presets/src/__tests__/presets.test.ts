import { describe, it, expect } from "vitest"
import {
  ANTHROPIC_GATEWAY_PRESETS,
  anthropicGatewayPresetList,
  getAnthropicGatewayPreset,
} from "../anthropic-gateways.js"
import type { ProviderPreset } from "../types.js"

describe("ANTHROPIC_GATEWAY_PRESETS", () => {
  it("exposes moonshot, openrouter, requesty, deepseek, xai, openai and openai-direct", () => {
    expect(Object.keys(ANTHROPIC_GATEWAY_PRESETS).sort()).toEqual([
      "deepseek",
      "moonshot",
      "openai",
      "openai-direct",
      "openrouter",
      "requesty",
      "xai",
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
        const url = new URL(preset.baseUrl)
        expect(url.protocol).toMatch(/^https?:$/)
        expect(preset.keyEnv).toMatch(/_API_KEY$/)
        expect(["anthropic", "openai"]).toContain(preset.schemaFlavor)
      })

      it("scrubs the ambient ANTHROPIC_API_KEY so it can't leak to the gateway", () => {
        // Only Anthropic-flavored gateways need to scrub the ambient key.
        // OpenAI-flavored presets (xai, openai, openai-direct) route to
        // their own provider and have no risk of leaking ANTHROPIC_API_KEY.
        if (preset.schemaFlavor === "anthropic") {
          expect(preset.scrubEnv).toContain("ANTHROPIC_API_KEY")
        }
      })

      it("satisfies the ProviderPreset type (compile-time shape guard)", () => {
        const _check: ProviderPreset = preset
        expect(_check).toBe(preset)
      })

      it("carries no /v1 suffix on an Anthropic-flavored base URL", () => {
        // The Anthropic client (claude binary + Agent SDK) appends
        // `/v1/messages` to ANTHROPIC_BASE_URL itself, so a /v1 already on the
        // preset produces `…/v1/v1/messages` → 404. The gateway then reports
        // that as "model may not exist or you may not have access to it",
        // which reads as a model/credential problem and hides the real cause —
        // exactly how the openrouter preset shipped broken. OpenAI-flavored
        // presets are exempt: those base URLs are used as-is by an
        // OpenAI-style client and legitimately end in /v1.
        if (preset.schemaFlavor === "anthropic") {
          expect(preset.baseUrl).not.toMatch(/\/v1\/?$/)
        }
      })
    })
  }

  it("moonshot pins the conventional default model", () => {
    expect(getAnthropicGatewayPreset("moonshot").defaultModel).toBe(
      "kimi-k2.7-code"
    )
  })

  it("deepseek pins the conventional default model", () => {
    expect(getAnthropicGatewayPreset("deepseek").defaultModel).toBe(
      "deepseek-v4-pro"
    )
  })

  it("xai pins the conventional default model", () => {
    expect(getAnthropicGatewayPreset("xai").defaultModel).toBe("grok-4.5")
  })

  it("openai pins the conventional default model", () => {
    expect(getAnthropicGatewayPreset("openai").defaultModel).toBe("gpt-4.1")
  })

  it("openrouter ships no pinned default model (operator picks via model option)", () => {
    expect(getAnthropicGatewayPreset("openrouter").defaultModel).toBeUndefined()
  })

  it("xai uses the intentional local OpenAI-compatible proxy", () => {
    const xai = getAnthropicGatewayPreset("xai")
    expect(xai.baseUrl).toBe("http://localhost:18090/v1")
    expect(xai.schemaFlavor).toBe("openai")
    expect(xai.defaultModel).toBe("grok-4.5")
  })

  it("openai uses the intentional local OpenAI-compatible proxy", () => {
    const openai = getAnthropicGatewayPreset("openai")
    expect(openai.baseUrl).toBe("http://localhost:18090/v1")
    expect(openai.schemaFlavor).toBe("openai")
    expect(openai.defaultModel).toBe("gpt-4.1")
  })

  it("external gateways (non-proxy) point at distinct base URLs", () => {
    // xai and openai go through the local llm-endpoint proxy — they share a baseUrl
    const externalPresets = anthropicGatewayPresetList.filter(
      (p) => p.id !== "xai" && p.id !== "openai"
    )
    const urls = externalPresets.map((p) => p.baseUrl)
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
