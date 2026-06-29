import { describe, expect, it } from "vitest"
import {
  modelRefToString,
  providerOf,
  resolveMastraModel,
} from "../model-resolver.js"

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
})
