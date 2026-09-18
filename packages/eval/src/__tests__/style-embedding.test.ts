import { describe, it, expect } from "vitest"
import { runTool } from "@agentproto/driver"
import {
  styleEmbeddingTool,
  makeStyleEmbeddingDriver,
  cosineToCentroid,
  EmbeddingDimensionError,
  type EmbedFn,
} from "../index.js"

describe("cosineToCentroid", () => {
  it("returns 1 when the candidate equals the centroid", () => {
    const references = [
      [1, 0, 0],
      [1, 0, 0],
    ]
    expect(cosineToCentroid([1, 0, 0], references)).toBeCloseTo(1, 10)
  })

  it("clamps an orthogonal candidate to 0, not 0.5 — an uninformative signal must not clear a 0.5 default threshold", () => {
    const references = [[1, 0]]
    expect(cosineToCentroid([0, 1], references)).toBeCloseTo(0, 10)
  })

  it("returns 0 when the candidate opposes the centroid", () => {
    const references = [[1, 0]]
    expect(cosineToCentroid([-1, 0], references)).toBeCloseTo(0, 10)
  })

  it("returns 0 for an empty references list", () => {
    expect(cosineToCentroid([1, 0], [])).toBe(0)
  })

  it("returns 0 for a zero candidate vector", () => {
    expect(cosineToCentroid([0, 0], [[1, 0]])).toBe(0)
  })

  it("returns 0 when every reference vector is zero", () => {
    expect(cosineToCentroid([1, 0], [[0, 0], [0, 0]])).toBe(0)
  })

  it("averages multiple references into a centroid", () => {
    const references = [
      [2, 0],
      [0, 2],
    ]
    // centroid = [1, 1]; candidate = [1, 1] → cosine 1
    expect(cosineToCentroid([1, 1], references)).toBeCloseTo(1, 10)
  })

  it("throws EmbeddingDimensionError when reference vectors have inconsistent dimensions", () => {
    expect(() => cosineToCentroid([1, 0], [[1, 0], [1, 0, 0]])).toThrow(EmbeddingDimensionError)
  })

  it("throws EmbeddingDimensionError when the candidate's dimension differs from the references'", () => {
    expect(() => cosineToCentroid([1, 0, 0], [[1, 0], [1, 0]])).toThrow(EmbeddingDimensionError)
  })
})

describe("eval.style-embedding — runTool", () => {
  it("scores 1 when the candidate embeds to the references' centroid", async () => {
    const embed: EmbedFn = async (texts) =>
      texts.map((t) => (t === "candidate" ? [1, 0] : [1, 0]))
    const driver = makeStyleEmbeddingDriver(embed)
    const score = await runTool({
      tool: styleEmbeddingTool,
      candidates: [driver],
      input: { candidate: "candidate", references: ["ref-1", "ref-2"] },
    })
    expect(score.label).toBe("style-embedding")
    expect(score.value).toBeCloseTo(1, 10)
    expect(score.passed).toBe(true)
  })

  it("scores low when the candidate is far from the centroid", async () => {
    const embed: EmbedFn = async (texts) =>
      texts.map((t) => (t === "candidate" ? [-1, 0] : [1, 0]))
    const driver = makeStyleEmbeddingDriver(embed)
    const score = await runTool({
      tool: styleEmbeddingTool,
      candidates: [driver],
      input: { candidate: "candidate", references: ["ref-1"] },
    })
    expect(score.value).toBeCloseTo(0, 10)
    expect(score.passed).toBe(false)
  })

  it("embeds candidate + all references in a single batch call", async () => {
    let seen: readonly string[] = []
    const embed: EmbedFn = async (texts) => {
      seen = texts
      return texts.map(() => [1, 0])
    }
    const driver = makeStyleEmbeddingDriver(embed)
    await runTool({
      tool: styleEmbeddingTool,
      candidates: [driver],
      input: { candidate: "c", references: ["r1", "r2"] },
    })
    expect(seen).toEqual(["c", "r1", "r2"])
  })

  it("honors a custom threshold", async () => {
    const embed: EmbedFn = async () => [[0, 1], [1, 0]] // candidate orthogonal to ref → clamped to 0
    const driver = makeStyleEmbeddingDriver(embed, { threshold: 0.9 })
    const score = await runTool({
      tool: styleEmbeddingTool,
      candidates: [driver],
      input: { candidate: "c", references: ["r1"] },
    })
    expect(score.value).toBeCloseTo(0, 10)
    expect(score.passed).toBe(false)
  })

  it("fails the score (no throw) when the embedder returns heterogeneous dimensions", async () => {
    const embed: EmbedFn = async () => [[1, 0], [1, 0, 0]]
    const driver = makeStyleEmbeddingDriver(embed)
    const score = await runTool({
      tool: styleEmbeddingTool,
      candidates: [driver],
      input: { candidate: "c", references: ["r1"] },
    })
    expect(score.passed).toBe(false)
    expect(score.value).toBe(0)
    expect(score.rationale).toMatch(/dimension/u)
  })
})
