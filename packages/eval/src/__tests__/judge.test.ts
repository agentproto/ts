import { describe, it, expect } from "vitest"
import { runTool } from "@agentproto/driver"
import {
  runEval,
  bindScorer,
  llmJudgeTool,
  makeLlmJudgeDriver,
  llmJudge,
  type JudgeFn,
  type JsonValue,
  type TypedEvalSuite,
} from "../index.js"

/**
 * A deterministic FAKE judge — no network, no model. Scores 1 when the
 * (string-shaped) `output` contains "good", else 0.2.
 */
const fakeJudge: JudgeFn = async ({ output }) => {
  const text = typeof output === "string" ? output : JSON.stringify(output)
  const value = text.includes("good") ? 1 : 0.2
  return {
    value,
    rationale: text.includes("good") ? "contains 'good'" : "missing 'good'",
  }
}

describe("eval.llm-judge — runTool", () => {
  it("yields a valid Score, with passed reflecting the default threshold", async () => {
    const driver = makeLlmJudgeDriver(fakeJudge)

    const good = await runTool({
      tool: llmJudgeTool,
      candidates: [driver],
      input: { output: "this is a good answer", criteria: "is it good?" },
    })
    expect(good).toMatchObject({ value: 1, passed: true, label: "llm-judge" })
    expect(good.rationale).toBe("contains 'good'")

    const bad = await runTool({
      tool: llmJudgeTool,
      candidates: [driver],
      input: { output: "this is a bad answer", criteria: "is it good?" },
    })
    expect(bad.value).toBeCloseTo(0.2, 10)
    expect(bad.passed).toBe(false)
  })

  it("passes `expected` through to the judge untouched", async () => {
    const seen: { expected?: JsonValue } = {}
    const capturingJudge: JudgeFn = async ({ output, expected }) => {
      seen.expected = expected
      return { value: typeof output === "string" && output === expected ? 1 : 0 }
    }
    const driver = makeLlmJudgeDriver(capturingJudge)

    const score = await runTool({
      tool: llmJudgeTool,
      candidates: [driver],
      input: { output: "hello", criteria: "matches expected", expected: "hello" },
    })
    expect(seen.expected).toBe("hello")
    expect(score.value).toBe(1)
  })
})

describe("eval.llm-judge — threshold boundary", () => {
  it("passes exactly at the threshold and fails just below it", async () => {
    const constantValueJudge = (value: number): JudgeFn =>
      async () => ({ value })

    const atThreshold = makeLlmJudgeDriver(constantValueJudge(0.7), { threshold: 0.7 })
    const atScore = await runTool({
      tool: llmJudgeTool,
      candidates: [atThreshold],
      input: { output: "x", criteria: "c" },
    })
    expect(atScore.value).toBe(0.7)
    expect(atScore.passed).toBe(true)

    const belowThreshold = makeLlmJudgeDriver(constantValueJudge(0.69), { threshold: 0.7 })
    const belowScore = await runTool({
      tool: llmJudgeTool,
      candidates: [belowThreshold],
      input: { output: "x", criteria: "c" },
    })
    expect(belowScore.value).toBeCloseTo(0.69, 10)
    expect(belowScore.passed).toBe(false)
  })

  it("defaults the threshold to 0.5 when none is supplied", async () => {
    const constantValueJudge = (value: number): JudgeFn => async () => ({ value })

    const atDefault = makeLlmJudgeDriver(constantValueJudge(0.5))
    const atDefaultScore = await runTool({
      tool: llmJudgeTool,
      candidates: [atDefault],
      input: { output: "x", criteria: "c" },
    })
    expect(atDefaultScore.passed).toBe(true)

    const belowDefault = makeLlmJudgeDriver(constantValueJudge(0.49))
    const belowDefaultScore = await runTool({
      tool: llmJudgeTool,
      candidates: [belowDefault],
      input: { output: "x", criteria: "c" },
    })
    expect(belowDefaultScore.passed).toBe(false)
  })

  it("explicit passed:false wins over a high value (explicit wins)", async () => {
    const overridingJudge: JudgeFn = async () => ({ value: 0.9, passed: false })
    const driver = makeLlmJudgeDriver(overridingJudge, { threshold: 0.5 })

    const score = await runTool({
      tool: llmJudgeTool,
      candidates: [driver],
      input: { output: "x", criteria: "c" },
    })
    expect(score.value).toBe(0.9)
    expect(score.passed).toBe(false)
  })

  it("explicit passed:true wins even under the threshold", async () => {
    const overridingJudge: JudgeFn = async () => ({ value: 0.1, passed: true })
    const driver = makeLlmJudgeDriver(overridingJudge, { threshold: 0.5 })

    const score = await runTool({
      tool: llmJudgeTool,
      candidates: [driver],
      input: { output: "x", criteria: "c" },
    })
    expect(score.value).toBeCloseTo(0.1, 10)
    expect(score.passed).toBe(true)
  })
})

describe("llmJudge(...) binding through bindScorer + runEval", () => {
  interface Answer {
    readonly text: string
  }

  function buildSuite(): TypedEvalSuite<{ prompt: string }, Answer> {
    return {
      id: "judge-suite",
      cases: [
        { id: "good-case", input: { prompt: "p1" } },
        { id: "bad-case", input: { prompt: "p2" } },
      ],
      scorers: [
        bindScorer(
          llmJudge<Answer>({
            id: "helpfulness",
            judge: fakeJudge,
            criteria: "Is the answer good?",
            mapOutput: ({ output }) => output.text,
          }),
        ),
      ],
    }
  }

  async function target(input: { prompt: string }): Promise<Answer> {
    return input.prompt === "p1"
      ? { text: "a good answer" }
      : { text: "a bad answer" }
  }

  it("produces the expected pass/fail aggregate", async () => {
    const suite = buildSuite()
    const report = await runEval(suite, { target, runId: "judge-run" })

    expect(report.total).toBe(2)
    expect(report.passedCount).toBe(1)

    const byId = new Map(report.cases.map((c) => [c.caseId, c]))
    expect(byId.get("good-case")?.passed).toBe(true)
    expect(byId.get("bad-case")?.passed).toBe(false)

    const goodScore = byId.get("good-case")?.scores.find((s) => s.scorerId === "helpfulness")
    expect(goodScore?.score.value).toBe(1)

    const badScore = byId.get("bad-case")?.scores.find((s) => s.scorerId === "helpfulness")
    expect(badScore?.score.value).toBeCloseTo(0.2, 10)
  })
})
