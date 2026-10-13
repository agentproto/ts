import { describe, it, expect } from "vitest"
import {
  AgentLaneReportError,
  buildAgentLanePrompt,
  parseAgentLaneReport,
  parseReviewManifest,
  type AgentCheck,
} from "../index.js"
import { readFileSync } from "node:fs"

const EXAMPLE = readFileSync(new URL("../../examples/REVIEW.md", import.meta.url), "utf8")

describe("parseAgentLaneReport", () => {
  it("parses a verdict file, defaulting detail", () => {
    const r = parseAgentLaneReport(
      JSON.stringify({
        decision: "request_changes",
        summary: "one bug",
        findings: [{ severity: "high", title: "off by one", file: "src/a.ts", line: 3 }],
      }),
    )
    expect(r).toEqual({
      decision: "request_changes",
      summary: "one bug",
      findings: [{ severity: "high", title: "off by one", detail: "", file: "src/a.ts", line: 3 }],
    })
  })

  it("tolerates a markdown fence", () => {
    const r = parseAgentLaneReport('```json\n{ "findings": [] }\n```\n')
    expect(r).toEqual({ findings: [] })
  })

  it("rejects non-JSON and off-contract JSON", () => {
    expect(() => parseAgentLaneReport("looks good to me")).toThrow(AgentLaneReportError)
    expect(() => parseAgentLaneReport('{"findings":[{"severity":"critical","title":"x"}]}')).toThrow(
      /does not match the lane contract — findings\.0\.severity/,
    )
    expect(() => parseAgentLaneReport('{"decision":"approve"}')).toThrow(/findings/)
  })
})

describe("buildAgentLanePrompt", () => {
  it("points the reviewer at the range, rubric and verdict path — no diff", () => {
    const check = parseReviewManifest(EXAMPLE).checks.find((c) => c.id === "correctness") as AgentCheck
    const prompt = buildAgentLanePrompt({
      reviewId: "agentproto-ts",
      check,
      target: { repoRemote: "r", baseSha: "aaa", headSha: "bbb" },
      rubricPath: "/repo/rubrics/correctness.md",
      verdictPath: "/state/reviews/x/correctness.json",
    })
    expect(prompt).toContain("review lane 'correctness' of review 'agentproto-ts'")
    expect(prompt).toContain("git range aaa..bbb")
    expect(prompt).toContain("/repo/rubrics/correctness.md")
    expect(prompt).toContain("write EXACTLY ONE file — /state/reviews/x/correctness.json")
    expect(prompt).toContain('blocks on any "high"-or-higher finding')
    expect(prompt).toContain("about 12 minute(s)")
  })

  it("states ONE consistent verdict rule with a schema-valid example", () => {
    const check = parseReviewManifest(EXAMPLE).checks.find((c) => c.id === "correctness") as AgentCheck
    const prompt = buildAgentLanePrompt({
      reviewId: "r",
      check,
      target: { repoRemote: "r", baseSha: "aaa", headSha: "bbb" },
      rubricPath: "/repo/rubrics/correctness.md",
      verdictPath: "/state/v.json",
    })
    // The embedded example is valid JSON and passes the canonical parser.
    const example = prompt.split("\n").find((l) => l.startsWith('{"decision"'))!
    expect(parseAgentLaneReport(example)).toMatchObject({ decision: "request_changes", findings: [{ severity: "high", line: 42 }] })
    // The file is the verdict; chat is not; uncertainty is never approval.
    expect(prompt).toMatch(/file IS your verdict/)
    expect(prompt).toMatch(/only in chat is not submitted/)
    expect(prompt).toMatch(/Uncertainty is not approval/)
    // decision/findings/blockOn can never contradict each other.
    expect(prompt).toMatch(/Only your "findings" decide the outcome/)
    expect(prompt).toMatch(/Never "request_changes" with an empty "findings"/)
    expect(prompt).toMatch(/never "approve" next to a blocking finding/)
    // Intentional API changes are not regressions.
    expect(prompt).toMatch(/ON PURPOSE/)
    expect(prompt).not.toMatch(/"approve" \| "request_changes"/)
  })
})
