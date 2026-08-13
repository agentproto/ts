import { describe, it, expect } from "vitest"
import {
  ANTHROPIC_GATEWAY_PRESETS,
  anthropicGatewayPresetList,
  findAnthropicGatewayPreset,
  getAnthropicGatewayPreset,
} from "../anthropic-gateways.js"
import type { ProviderPreset } from "../types.js"

describe("ANTHROPIC_GATEWAY_PRESETS", () => {
  it("exposes the full endpoint catalog (anthropic-flavored gateways + openai-flavored direct providers)", () => {
    expect(Object.keys(ANTHROPIC_GATEWAY_PRESETS).sort()).toEqual([
      "deepinfra",
      "deepseek",
      "groq",
      "huggingface",
      "llm-endpoint",
      "mistral",
      "moonshot",
      "nebius",
      "openai",
      "openai-direct",
      "openrouter",
      "requesty",
      "xai",
      "xai-anthropic",
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
        // Conventionally a `<PROVIDER>_API_KEY` var — except the local
        // llm-endpoint proxy, whose client bearer IS the proxy's own inbound
        // shared-secret gate var (`LLM_ENDPOINT_ACCESS_TOKENS`), so one value
        // serves both sides of the localhost loop — and Hugging Face, whose
        // ecosystem-wide convention is `HF_TOKEN` (what every HF tool reads);
        // inventing an HF_API_KEY here would break ambient-credential pickup.
        expect(preset.keyEnv).toMatch(/(_API_KEY|_ACCESS_TOKENS|_TOKEN)$/)
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

  it("llm-endpoint points at the local Anthropic-compatible proxy with no /v1 suffix", () => {
    const ep = getAnthropicGatewayPreset("llm-endpoint")
    expect(ep.baseUrl).toBe("http://localhost:18090")
    expect(ep.schemaFlavor).toBe("anthropic")
    // keyEnv MUST be the same var the proxy's inbound gate reads
    // (`parseAccessTokens(process.env.LLM_ENDPOINT_ACCESS_TOKENS)` in
    // @agentproto/llm-endpoint) — otherwise the profile's presented bearer is
    // read from a var the proxy never checks and the gate 401s. The dead
    // `LLM_ENDPOINT_API_KEY` (read by neither side) must not reappear.
    expect(ep.keyEnv).toBe("LLM_ENDPOINT_ACCESS_TOKENS")
    expect(ep.keyEnv).not.toBe("LLM_ENDPOINT_API_KEY")
    expect(ep.defaultModel).toBe("kimi-k2.7-code")
    expect(ep.scrubEnv).toContain("ANTHROPIC_API_KEY")
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

  it("mistral pins its own stable -latest alias as default model", () => {
    const m = getAnthropicGatewayPreset("mistral")
    expect(m.defaultModel).toBe("mistral-large-latest")
    expect(m.schemaFlavor).toBe("openai")
    expect(m.baseUrl).toBe("https://api.mistral.ai/v1")
  })

  it("rotating-lineup direct providers ship no pinned default model", () => {
    // groq/nebius/huggingface/deepinfra lineups churn; a pinned default would
    // rot into a 404 the way a hardcoded model id always does. The operator
    // picks via the model option against GET /models.
    for (const id of ["groq", "nebius", "huggingface", "deepinfra"] as const) {
      expect(getAnthropicGatewayPreset(id).defaultModel).toBeUndefined()
    }
  })

  it("huggingface keeps the ecosystem HF_TOKEN convention as keyEnv", () => {
    expect(getAnthropicGatewayPreset("huggingface").keyEnv).toBe("HF_TOKEN")
  })

  it("xai-anthropic points directly at xAI with no /v1 suffix and Anthropic flavor", () => {
    const xa = getAnthropicGatewayPreset("xai-anthropic")
    expect(xa.baseUrl).toBe("https://api.x.ai")
    expect(xa.schemaFlavor).toBe("anthropic")
    expect(xa.keyEnv).toBe("XAI_API_KEY")
    expect(xa.defaultModel).toBe("grok-4.5")
    expect(xa.scrubEnv).toContain("ANTHROPIC_API_KEY")
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

describe("findAnthropicGatewayPreset", () => {
  it("returns a built-in preset for a known id", () => {
    expect(findAnthropicGatewayPreset("moonshot")?.keyEnv).toBe("MOONSHOT_API_KEY")
    expect(findAnthropicGatewayPreset("llm-endpoint")?.keyEnv).toBe("LLM_ENDPOINT_ACCESS_TOKENS")
  })

  it("returns undefined for an unknown id", () => {
    expect(findAnthropicGatewayPreset("not-a-preset")).toBeUndefined()
  })
})
