import { describe, it, expect } from "vitest"
import { evaluateAccess } from "../evaluate.js"
import type { ResolvedModel } from "../../registry/index.js"
import type { AccessRule } from "../types.js"

// Minimal voice ResolvedModel — the evaluator only reads `.voice.provider`
// for the voice case, so a narrow stub keeps the test decoupled from the
// full CatalogVoice shape.
function voiceModel(provider: string): ResolvedModel {
  return {
    kind: "voice",
    id: `voice:${provider}:sample`,
    voice: { provider },
  } as unknown as ResolvedModel
}

const block = (value: string): AccessRule => ({
  effect: "block",
  target: { kind: "provider", value },
})

describe("evaluateAccess — voice provider rules", () => {
  // Regression: previously the voice branch hardcoded `=== "minimax"`, so a
  // `block provider:elevenlabs` rule silently never matched.
  it("blocks a voice by its ACTUAL provider, not a hardcoded one", () => {
    const d = evaluateAccess({
      model: voiceModel("elevenlabs"),
      rules: [block("elevenlabs")],
    })
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain("rule:provider:elevenlabs:block")
  })

  it("does NOT apply a provider rule to a different voice provider", () => {
    const d = evaluateAccess({
      model: voiceModel("elevenlabs"),
      rules: [block("minimax")],
    })
    // The minimax rule must not match an elevenlabs voice → no provider rule
    // fired (decision came from catalog defaults, whatever it is).
    expect(d.reason.startsWith("rule:provider")).toBe(false)
  })

  it("still blocks minimax voices when minimax is targeted", () => {
    const d = evaluateAccess({
      model: voiceModel("minimax"),
      rules: [block("minimax")],
    })
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain("rule:provider:minimax:block")
  })
})
