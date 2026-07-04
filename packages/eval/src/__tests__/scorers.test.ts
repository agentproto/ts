import { describe, it, expect } from "vitest"
import { runTool } from "@agentproto/driver"
import {
  exactMatchTool,
  regexMatchTool,
  jsonSchemaValidTool,
  latencyBudgetTool,
  evalScorersProvider,
} from "../index.js"

const candidates = [evalScorersProvider]

describe("eval.exact-match", () => {
  it("passes on an exact match", async () => {
    const score = await runTool({
      tool: exactMatchTool,
      candidates,
      input: { actual: "hello", expected: "hello" },
    })
    expect(score).toMatchObject({ value: 1, passed: true, label: "exact-match" })
  })

  it("fails on a mismatch", async () => {
    const score = await runTool({
      tool: exactMatchTool,
      candidates,
      input: { actual: "hello", expected: "world" },
    })
    expect(score.value).toBe(0)
    expect(score.passed).toBe(false)
  })

  it("honors the trim option (edge case)", async () => {
    const score = await runTool({
      tool: exactMatchTool,
      candidates,
      input: { actual: "  hi  ", expected: "hi", trim: true },
    })
    expect(score.passed).toBe(true)
    expect(score.value).toBe(1)
  })
})

describe("eval.regex-match", () => {
  it("passes when the pattern matches", async () => {
    const score = await runTool({
      tool: regexMatchTool,
      candidates,
      input: { actual: "abc123", pattern: "^[a-z]+\\d+$" },
    })
    expect(score).toMatchObject({ value: 1, passed: true, label: "regex-match" })
  })

  it("fails when the pattern does not match", async () => {
    const score = await runTool({
      tool: regexMatchTool,
      candidates,
      input: { actual: "ABC", pattern: "^[a-z]+$" },
    })
    expect(score.value).toBe(0)
    expect(score.passed).toBe(false)
  })

  it("returns a typed failure Score on an invalid pattern (edge case)", async () => {
    const score = await runTool({
      tool: regexMatchTool,
      candidates,
      input: { actual: "anything", pattern: "([unterminated" },
    })
    expect(score.value).toBe(0)
    expect(score.passed).toBe(false)
    expect(score.rationale).toMatch(/^invalid pattern:/)
  })
})

describe("eval.json-schema-valid", () => {
  const schema = {
    type: "object",
    required: ["name", "age"],
    properties: { name: { type: "string" }, age: { type: "number" } },
  }

  it("passes when the value satisfies required + property types", async () => {
    const score = await runTool({
      tool: jsonSchemaValidTool,
      candidates,
      input: { actual: { name: "Ada", age: 36 }, schema },
    })
    expect(score).toMatchObject({ value: 1, passed: true, label: "json-schema-valid" })
  })

  it("fails and reports the wrong property type", async () => {
    const score = await runTool({
      tool: jsonSchemaValidTool,
      candidates,
      input: { actual: { name: "Ada", age: "thirty-six" }, schema },
    })
    expect(score.value).toBe(0)
    expect(score.passed).toBe(false)
    expect(score.rationale).toContain("'age'")
  })

  it("fails on a missing required property (edge case)", async () => {
    const score = await runTool({
      tool: jsonSchemaValidTool,
      candidates,
      input: { actual: { name: "Ada" }, schema },
    })
    expect(score.value).toBe(0)
    expect(score.passed).toBe(false)
    expect(score.rationale).toContain("missing required property 'age'")
  })
})

describe("eval.latency-budget", () => {
  it("passes when within budget", async () => {
    const score = await runTool({
      tool: latencyBudgetTool,
      candidates,
      input: { durationMs: 100, budgetMs: 200 },
    })
    expect(score).toMatchObject({ value: 1, passed: true, label: "latency-budget" })
  })

  it("fails and decays when over budget (edge case)", async () => {
    const score = await runTool({
      tool: latencyBudgetTool,
      candidates,
      input: { durationMs: 300, budgetMs: 200 },
    })
    expect(score.passed).toBe(false)
    // overrun of half a budget → value 0.5
    expect(score.value).toBeCloseTo(0.5, 5)
    expect(score.rationale).toContain("durationMs=300")
  })

  it("clamps to 0 when the overrun exceeds a full budget", async () => {
    const score = await runTool({
      tool: latencyBudgetTool,
      candidates,
      input: { durationMs: 1000, budgetMs: 200 },
    })
    expect(score.passed).toBe(false)
    expect(score.value).toBe(0)
  })
})
