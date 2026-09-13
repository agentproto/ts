import { describe, expect, it, vi } from "vitest"
import {
  modelRefToString,
  normalizeModelId,
  providerOf,
  resolveMastraModel,
} from "../model-resolver.js"

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn((opts: Record<string, unknown>) => {
    return (modelId: string) => ({
      _oatModel: true,
      authToken: opts.authToken,
      modelId,
    })
  }),
}))

describe("modelRefToString", () => {
  it("passes a bare string through, trimmed", () => {
    expect(modelRefToString("  anthropic/claude-opus-4-8 ")).toBe(
      "anthropic/claude-opus-4-8",
    )
  })

  it("extracts the ref field from a structured ref", () => {
    expect(modelRefToString({ ref: "openrouter/z-ai/glm-5.2" })).toBe(
      "openrouter/z-ai/glm-5.2",
    )
  })

  it("throws on an inline-only model object", () => {
    expect(() => modelRefToString({ inline: { foo: 1 } })).toThrow(
      /provider\/model/,
    )
  })
})

describe("providerOf", () => {
  it("takes the segment before the first slash", () => {
    expect(providerOf("anthropic/claude-opus-4-8")).toBe("anthropic")
    expect(providerOf("openrouter/z-ai/glm-5.2")).toBe("openrouter")
  })
})

describe("resolveMastraModel", () => {
  const env = {
    ANTHROPIC_API_KEY: "sk-ant",
    OPENAI_API_KEY: "sk-oai",
    OPENROUTER_API_KEY: "sk-or",
  }

  it("returns the model id when the provider key is present", () => {
    expect(resolveMastraModel("anthropic/claude-opus-4-8", env)).toBe(
      "anthropic/claude-opus-4-8",
    )
    expect(resolveMastraModel("openai/gpt-5", env)).toBe("openai/gpt-5")
    expect(resolveMastraModel({ ref: "openrouter/z-ai/glm-5.2" }, env)).toBe(
      "openrouter/z-ai/glm-5.2",
    )
  })

  it("throws a friendly error when the provider key is missing", () => {
    expect(() => resolveMastraModel("anthropic/claude-opus-4-8", {})).toThrow(
      /ANTHROPIC_API_KEY/,
    )
  })

  it("passes unknown providers through without a key check", () => {
    expect(resolveMastraModel("localhost/my-model", {})).toBe(
      "localhost/my-model",
    )
  })

  it("infers anthropic for a bare Claude id, so a portable AGENT.md routes", () => {
    // `claude-sonnet-5` is what claude-code / claude-sdk accept bare; here it
    // must become `anthropic/claude-sonnet-5` or Mastra's gateway can't route.
    expect(resolveMastraModel("claude-sonnet-5", env)).toBe(
      "anthropic/claude-sonnet-5",
    )
    // Still key-checked under the inferred provider.
    expect(() => resolveMastraModel("claude-sonnet-5", {})).toThrow(
      /ANTHROPIC_API_KEY/,
    )
  })

  it("returns a model object (not a string) when ANTHROPIC_API_KEY is an OAT", () => {
    const oatEnv = { ANTHROPIC_API_KEY: "sk-ant-oat01-abc123" }
    const result = resolveMastraModel("anthropic/claude-sonnet-5", oatEnv)
    expect(result).toEqual({
      _oatModel: true,
      authToken: "sk-ant-oat01-abc123",
      modelId: "claude-sonnet-5",
    })
  })

  it("strips the anthropic/ prefix from the model id for the OAT provider", () => {
    const oatEnv = { ANTHROPIC_API_KEY: "sk-ant-oat01-xyz" }
    const result = resolveMastraModel("anthropic/claude-opus-4-8", oatEnv) as unknown as {
      modelId: string
    }
    expect(result.modelId).toBe("claude-opus-4-8")
  })

  it("handles a bare Claude id with an OAT (normalization + OAT path)", () => {
    const oatEnv = { ANTHROPIC_API_KEY: "sk-ant-oat01-def" }
    const result = resolveMastraModel("claude-sonnet-5", oatEnv) as unknown as {
      modelId: string
      authToken: string
    }
    expect(result.modelId).toBe("claude-sonnet-5")
    expect(result.authToken).toBe("sk-ant-oat01-def")
  })

  it("still returns a string for a regular Anthropic API key", () => {
    const regularEnv = { ANTHROPIC_API_KEY: "sk-ant-api03-regular" }
    expect(resolveMastraModel("anthropic/claude-opus-4-8", regularEnv)).toBe(
      "anthropic/claude-opus-4-8",
    )
  })
})

describe("normalizeModelId", () => {
  it("infers anthropic for a bare Claude id", () => {
    expect(normalizeModelId("claude-sonnet-5")).toBe("anthropic/claude-sonnet-5")
    expect(normalizeModelId("claude-opus-4-8")).toBe("anthropic/claude-opus-4-8")
  })

  it("leaves an already-prefixed id untouched", () => {
    expect(normalizeModelId("anthropic/claude-sonnet-5")).toBe(
      "anthropic/claude-sonnet-5",
    )
    expect(normalizeModelId("openrouter/z-ai/glm-5.2")).toBe(
      "openrouter/z-ai/glm-5.2",
    )
  })

  it("leaves a non-Claude bare id alone (still needs an explicit provider)", () => {
    expect(normalizeModelId("gpt-5")).toBe("gpt-5")
  })
})
