import { describe, expect, it } from "vitest"

import { opencode } from "./index.js"

describe("@agentproto/adapter-opencode", () => {
  it("declares model-derived api-key auth", () => {
    expect(opencode.modelDerivedApiKey).toBe(true)
    expect(opencode.routeSelection).toBe("derived-from-model")
  })

  it("declares the external anthropic-scoped subscription (opencode's own Claude Pro/Max login)", () => {
    // External: the runtime injects no bearer (an agentproto-held OAT on
    // opencode's x-api-key channel is rejected upstream) — it verifies the
    // CLI's own `opencode auth login` is present and scrubs api-key vars.
    expect(opencode.authSubscription).toEqual({
      external: true,
      provider: "anthropic",
    })
  })

  it("generates the model menu from the shared catalog for supported providers", () => {
    const allowed = opencode.models?.allowed ?? []
    const ids = allowed.map((entry) =>
      typeof entry === "string" ? entry : entry.id,
    )
    const providers = allowed
      .filter((entry): entry is { id: string; provider: string } =>
        typeof entry !== "string",
      )
      .map((entry) => entry.provider)

    // Anthropic and OpenAI direct prefixes.
    expect(ids).toContain("anthropic/claude-sonnet-4-5")
    expect(ids).toContain("openai/gpt-5")

    // OpenRouter router prefix.
    expect(ids.some((id) => id.startsWith("openrouter/"))).toBe(true)

    // Only supported providers are represented in the generated menu.
    expect(new Set(providers)).toEqual(
      new Set(["anthropic", "openai", "openrouter"]),
    )

    // Groq and OpenCode-hosted are not in the shared catalog today, so they do
    // not appear in the generated menu (free-form `model` still accepts them).
    expect(providers).not.toContain("groq")
    expect(providers).not.toContain("opencode")
  })

  it("keeps a canonical catalog model as the default", () => {
    expect(opencode.models?.default).toBe("anthropic/claude-sonnet-4-5")
  })

  it("has no duplicate model ids in the generated menu", () => {
    const allowed = opencode.models?.allowed ?? []
    const ids = allowed.map((entry) =>
      typeof entry === "string" ? entry : entry.id,
    )
    expect(new Set(ids).size).toBe(ids.length)
  })
})
