import { describe, it, expect } from "vitest"
import { evaluateAccess } from "../evaluate.js"
import type { ResolvedModel } from "../../registry/index.js"
import type { AccessRule } from "../types.js"

// Narrow LLM stub — the evaluator reads `.kind`, `.id`, `.canonicalId` for the
// rule cases exercised here (model / kind / provider bands). Avoids coupling to
// the enrichment layer (tag / priceTier), which is tested elsewhere.
function llmModel(id: string, canonicalId: string): ResolvedModel {
  return { kind: "llm", id, canonicalId } as unknown as ResolvedModel
}

const allow = (t: AccessRule["target"]): AccessRule => ({ effect: "allow", target: t })
const block = (t: AccessRule["target"]): AccessRule => ({ effect: "block", target: t })

describe("evaluateAccess — LLM provider matching (blocker-3 regression)", () => {
  it("matches the vendor segment of a router-prefixed canonical id", () => {
    const d = evaluateAccess({
      model: llmModel("gemini-2.5", "openrouter/google/gemini-2.5"),
      rules: [block({ kind: "provider", value: "google" })],
    })
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain("rule:provider:google:block")
  })

  it("matches a bare <vendor>/… canonical id by prefix", () => {
    const d = evaluateAccess({
      model: llmModel("gpt-5", "openai/gpt-5"),
      rules: [block({ kind: "provider", value: "openai" })],
    })
    expect(d.allowed).toBe(false)
  })

  it("does NOT false-positive on a substring match", () => {
    // canonicalId merely CONTAINS "google" — must not be treated as the vendor.
    const d = evaluateAccess({
      model: llmModel("non-google-flash", "vendorx/non-google-flash"),
      rules: [block({ kind: "provider", value: "google" })],
    })
    expect(d.reason.startsWith("rule:provider")).toBe(false)
  })
})

describe("evaluateAccess — bands & explicit rules", () => {
  it("explicit model block wins over a tier allow", () => {
    const model = llmModel("claude-x", "anthropic/claude-x")
    const d = evaluateAccess({
      model,
      rules: [
        allow({ kind: "model", id: "claude-x" }),
        block({ kind: "model", id: "claude-x" }),
      ],
    })
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain("rule:model:block")
  })

  it("more-specific provider band beats a blanket kind block", () => {
    const model = llmModel("gemini-2.5", "openrouter/google/gemini-2.5")
    const d = evaluateAccess({
      model,
      rules: [
        block({ kind: "kind", value: "llm" }),
        allow({ kind: "provider", value: "google" }),
      ],
    })
    // provider (specificity 3) > kind (1) → the allow wins.
    expect(d.allowed).toBe(true)
    expect(d.reason).toContain("rule:provider:google:allow")
  })

  it("falls through to catalog defaults when no rule matches", () => {
    const d = evaluateAccess({
      model: llmModel("gemini-2.5", "openrouter/google/gemini-2.5"),
      rules: [block({ kind: "provider", value: "anthropic" })],
    })
    expect(d.reason.startsWith("rule:")).toBe(false)
  })
})
