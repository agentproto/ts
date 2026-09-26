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

  it("matches accented terms as whole words — \\b is ASCII-only and misses these", async () => {
    const score = await runTool({
      tool: lexiconHitRateTool,
      candidates,
      input: { text: "il aime écrire la vérité, même pour un benêt", lexicon: ["écrire", "vérité", "benêt"] },
    })
    expect(score.value).toBe(1)
  })

  it("does not false-positive an accented term as a substring of a longer accented word", async () => {
    const score = await runTool({
      tool: lexiconHitRateTool,
      candidates,
      input: { text: "le prétexte ne suffit pas", lexicon: ["texte"] },
    })
    expect(score.value).toBe(0)
  })

  it("matches regardless of NFC/NFD normalization of the input text", async () => {
    const nfd = "il aime écrire".normalize("NFD") // "é" as e + combining acute accent
    const score = await runTool({
      tool: lexiconHitRateTool,
      candidates,
      input: { text: nfd, lexicon: ["écrire"] },
    })
    expect(score.value).toBe(1)
  })

  it("rejects an empty lexicon at the schema boundary", async () => {
    await expect(
      runTool({
        tool: lexiconHitRateTool,
        candidates,
        input: { text: "peu importe", lexicon: [] },
      }),
    ).rejects.toThrow()
  })
})

describe("extractLexicon with a background corpus", () => {
  it("without a background corpus, ranks purely by raw frequency", () => {
    const foreground = ["chat chat chat forge", "chat forge"]
    const lexicon = extractLexicon(foreground, { top: 2, minLen: 3 })
    expect(lexicon).toEqual(["chat", "forge"]) // chat (4) outranks forge (2) on raw count
  })

  it("with a background corpus, a term frequent in both ranks below one specific to the foreground, even with a lower raw count", () => {
    const foreground = ["chat chat chat forge", "chat forge"] // chat: 4, forge: 2
    const background = ["chat chat chat chat chat chat", "chat chat"] // chat: 8, forge: 0
    const lexicon = extractLexicon(foreground, { top: 2, minLen: 3, background })
    expect(lexicon).toEqual(["forge", "chat"]) // log-odds flips the raw-frequency order
  })
})
