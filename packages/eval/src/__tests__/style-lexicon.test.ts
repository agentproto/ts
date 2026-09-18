import { describe, it, expect } from "vitest"
import { runTool } from "@agentproto/driver"
import { lexiconHitRateTool, styleScorersProvider, extractLexicon } from "../index.js"

const candidates = [styleScorersProvider]

describe("extractLexicon", () => {
  it("returns the most frequent non-stopword terms across a corpus", () => {
    const corpus = [
      "le chat mange le poisson",
      "le chat dort sur le canapé",
      "le chien joue avec le chat",
    ]
    const lexicon = extractLexicon(corpus, { top: 3, minLen: 3 })
    expect(lexicon).toContain("chat")
    expect(lexicon).not.toContain("le") // stopword
  })

  it("respects minLen", () => {
    const lexicon = extractLexicon(["un ami visite la forge avec son ami forgeron"], { minLen: 5 })
    expect(lexicon.length).toBeGreaterThan(0)
    expect(lexicon.every((w) => w.length >= 5)).toBe(true)
    expect(lexicon).not.toContain("ami") // below minLen
  })

  it("respects top", () => {
    const corpus = ["alpha beta gamma delta epsilon zeta alpha beta gamma delta epsilon zeta"]
    const lexicon = extractLexicon(corpus, { top: 2, minLen: 3 })
    expect(lexicon.length).toBe(2)
  })
})

describe("eval.lexicon-hit-rate — runTool", () => {
  it("computes hit rate over provided lexicon terms", async () => {
    const score = await runTool({
      tool: lexiconHitRateTool,
      candidates,
      input: { text: "le forgeron martèle le fer chaud", lexicon: ["forgeron", "fer", "absent"] },
    })
    expect(score.label).toBe("lexicon-hit-rate")
    expect(score.value).toBeCloseTo(2 / 3, 10)
  })

  it("passes when hit rate clears the threshold", async () => {
    const score = await runTool({
      tool: lexiconHitRateTool,
      candidates,
      input: { text: "forgeron fer", lexicon: ["forgeron", "fer"], threshold: 1 },
    })
    expect(score.passed).toBe(true)
    expect(score.value).toBe(1)
  })

  it("fails when hit rate misses the default threshold", async () => {
    const score = await runTool({
      tool: lexiconHitRateTool,
      candidates,
      input: { text: "rien du tout ici", lexicon: ["forgeron", "fer", "enclume"] },
    })
    expect(score.passed).toBe(false)
    expect(score.value).toBe(0)
  })

  it("only matches whole words, not substrings", async () => {
    const score = await runTool({
      tool: lexiconHitRateTool,
      candidates,
      input: { text: "chatouille", lexicon: ["chat"] },
    })
    expect(score.value).toBe(0)
  })
})
