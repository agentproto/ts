import { describe, it, expect } from "vitest"
import { runTool } from "@agentproto/driver"
import { outlineFidelityTool, makeOutlineFidelityDriver, type JudgeFn } from "../index.js"

describe("eval.outline-fidelity — runTool", () => {
  it("passes when the judge reports full coverage", async () => {
    const judge: JudgeFn = async () => ({ value: 1, rationale: "every point covered" })
    const driver = makeOutlineFidelityDriver(judge)
    const score = await runTool({
      tool: outlineFidelityTool,
      candidates: [driver],
      input: { outline: "- point 1\n- point 2", answer: "Point 1 et point 2 expliqués." },
    })
    expect(score.label).toBe("outline-fidelity")
    expect(score.value).toBe(1)
    expect(score.passed).toBe(true)
  })

  it("fails below the fixed 0.95 gate even at value 0.9", async () => {
    const judge: JudgeFn = async () => ({ value: 0.9 })
    const driver = makeOutlineFidelityDriver(judge)
    const score = await runTool({
      tool: outlineFidelityTool,
      candidates: [driver],
      input: { outline: "- point 1\n- point 2", answer: "Seulement le point 1." },
    })
    expect(score.value).toBe(0.9)
    expect(score.passed).toBe(false)
  })

  it("ignores the judge's own passed — the 0.95 gate always wins", async () => {
    const judge: JudgeFn = async () => ({ value: 0.96, passed: false })
    const driver = makeOutlineFidelityDriver(judge)
    const score = await runTool({
      tool: outlineFidelityTool,
      candidates: [driver],
      input: { outline: "- point 1", answer: "Point 1." },
    })
    expect(score.value).toBe(0.96)
    expect(score.passed).toBe(true)
  })

  it("passes outline as expected and answer as output to the judge", async () => {
    const seen: { output?: unknown; expected?: unknown } = {}
    const judge: JudgeFn = async ({ output, expected }) => {
      seen.output = output
      seen.expected = expected
      return { value: 1 }
    }
    const driver = makeOutlineFidelityDriver(judge)
    await runTool({
      tool: outlineFidelityTool,
      candidates: [driver],
      input: { outline: "OUTLINE", answer: "ANSWER" },
    })
    expect(seen.output).toBe("ANSWER")
    expect(seen.expected).toBe("OUTLINE")
  })

  it("clamps an out-of-range judge value into [0, 1]", async () => {
    const judge: JudgeFn = async () => ({ value: 1 })
    const driver = makeOutlineFidelityDriver(judge)
    const score = await runTool({
      tool: outlineFidelityTool,
      candidates: [driver],
      input: { outline: "o", answer: "a" },
    })
    expect(score.value).toBeLessThanOrEqual(1)
    expect(score.value).toBeGreaterThanOrEqual(0)
  })
})
