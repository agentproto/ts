import { describe, it, expect } from "vitest"
import { runTool } from "@agentproto/driver"
import {
  textStatsTool,
  styleScorersProvider,
  bulletsRatio,
  firstPersonRatio,
  questionRate,
  meanSentenceLength,
  computeTextStats,
} from "../index.js"

const candidates = [styleScorersProvider]

describe("bulletsRatio", () => {
  it("counts lines starting with -, *, •, or '1.'", () => {
    const text = "- un\n* deux\n• trois\n1. quatre\nprose normale"
    expect(bulletsRatio(text)).toBeCloseTo(4 / 5, 10)
  })

  it("is 0 for prose with no bullets", () => {
    expect(bulletsRatio("Ceci est une phrase.\nEt une autre.")).toBe(0)
  })
})

describe("firstPersonRatio", () => {
  it("detects je/j'/moi/mon/ma/mes", () => {
    const text = "Je pense que c'est bien. Moi, je préfère ça. Le chat dort."
    expect(firstPersonRatio(text)).toBeCloseTo(2 / 3, 10)
  })

  it("is 0 when no first-person marker appears", () => {
    expect(firstPersonRatio("Le chat dort. Il fait beau.")).toBe(0)
  })
})

describe("questionRate", () => {
  it("counts sentences ending in ?", () => {
    expect(questionRate("Tu viens ? Oui. Vraiment ?")).toBeCloseTo(2 / 3, 10)
  })
})

describe("meanSentenceLength", () => {
  it("averages word counts across sentences", () => {
    expect(meanSentenceLength("un deux trois. quatre cinq.")).toBeCloseTo(2.5, 10)
  })

  it("returns 0 for empty text", () => {
    expect(meanSentenceLength("")).toBe(0)
  })
})

describe("computeTextStats", () => {
  it("flags inBand true/false against a given band", () => {
    const short = computeTextStats("un deux trois.", { min: 5, max: 30 })
    expect(short.inBand).toBe(false)
    const inBand = computeTextStats("un deux trois quatre cinq six sept.", { min: 5, max: 30 })
    expect(inBand.inBand).toBe(true)
  })
})

describe("eval.text-stats — runTool", () => {
  it("passes when all thresholds are met", async () => {
    const text = "Je pense que ceci est une bonne réponse avec plusieurs mots."
    const score = await runTool({
      tool: textStatsTool,
      candidates,
      input: { text, thresholds: { maxBulletsRatio: 0.5, minFirstPersonRatio: 0.5, lengthBand: { min: 3, max: 30 } } },
    })
    expect(score.label).toBe("text-stats")
    expect(score.passed).toBe(true)
    expect(score.value).toBe(1)
  })

  it("fails when bullets ratio exceeds the threshold", async () => {
    const text = "- un\n- deux\n- trois"
    const score = await runTool({
      tool: textStatsTool,
      candidates,
      input: { text, thresholds: { maxBulletsRatio: 0.02 } },
    })
    expect(score.passed).toBe(false)
  })

  it("uses default thresholds when none are supplied", async () => {
    const score = await runTool({
      tool: textStatsTool,
      candidates,
      input: { text: "Le chat dort paisiblement sur le canapé du salon." },
    })
    expect(score.label).toBe("text-stats")
    expect(score.passed).toBe(false) // no first-person marker present
  })
})
