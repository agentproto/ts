import { describe, expect, it } from "vitest"
import {
  RECOVERED_SUMMARY,
  RECOVERY_EVIDENCE_MAX_CHARS,
  analyzeReviewerTranscript,
  boundEvidence,
  buildFollowUpPrompt,
  buildRecoveryPrompt,
  evaluateRecoveryReply,
  extractExplicitReport,
  substantiveChars,
} from "../review-verdict-recovery.js"

const EVIDENCE = [
  "Checked src/a.ts and its callers.",
  "The loop never terminates when the list is empty. This is a high severity problem at src/a.ts:3.",
  "It should be fixed before merging.",
].join("\n")
const ctx = { evidence: EVIDENCE, lifecycle: "clean" as const, blockOn: "high" as const, followUpPossible: true }
const finding = (o: Record<string, unknown> = {}) => ({
  severity: "high",
  title: "The loop never terminates when the list is empty.",
  file: "src/a.ts",
  line: 3,
  ...o,
})
const envelope = (o: Record<string, unknown> = {}) => JSON.stringify({ status: "recovered", findings: [finding()], ...o })

describe("boundEvidence", () => {
  it("keeps the TAIL within the cap and drops thought/tool framing but keeps tool errors", () => {
    const lines = ["\x1b[2m[thought] hmm\x1b[0m", "[tool] Read(a)", "early noise ".repeat(5000), "the conclusion line", "\x1b[31m[tool-error] boom\x1b[0m"]
    const out = boundEvidence(lines)
    expect(out.length).toBeLessThanOrEqual(RECOVERY_EVIDENCE_MAX_CHARS + 40)
    expect(out).toContain("the conclusion line")
    expect(out).toContain("[tool-error] boom")
    expect(out).not.toContain("hmm")
    expect(out).not.toContain("Read(a)")
    expect(out.startsWith("[earlier output omitted]")).toBe(true)
  })

  it("substantiveChars ignores error and framing lines", () => {
    expect(substantiveChars("[error] 500\n[tool-error] x")).toBe(0)
    expect(substantiveChars("real prose here")).toBe("real prose here".length)
  })
})

describe("evaluateRecoveryReply", () => {
  it("lifts grounded blocking findings exactly, tolerates a fence, and overwrites the model's summary", () => {
    const d = evaluateRecoveryReply(`\`\`\`json\n${envelope({ report: { summary: "model words" } })}\n\`\`\``, ctx)
    expect(d).toMatchObject({
      kind: "recovered",
      report: { decision: "request_changes", summary: RECOVERED_SUMMARY, findings: [finding()] },
    })
  })

  it("never mints an approval: an approve report, an empty findings list, or prose is invalid", () => {
    expect(evaluateRecoveryReply(envelope({ report: { decision: "approve", findings: [] }, findings: undefined }), ctx)).toMatchObject({
      kind: "invalid",
      reason: expect.stringMatching(/never records an approval/),
    })
    expect(evaluateRecoveryReply(envelope({ findings: [] }), ctx)).toMatchObject({ kind: "invalid" })
    expect(evaluateRecoveryReply(envelope({ findings: undefined }), ctx)).toMatchObject({ kind: "invalid" })
  })

  it("rejects the planning-sentence + fabricated approve case that a 12-char quote used to accept", () => {
    const planning = { ...ctx, evidence: "I will inspect the changed files next.\nStarting with the diff." }
    const fabricated = JSON.stringify({
      status: "recovered",
      conclusionQuote: "I will inspect the changed files next.",
      report: { decision: "approve", summary: "all good", findings: [] },
    })
    expect(evaluateRecoveryReply(fabricated, planning)).toMatchObject({ kind: "invalid" })
  })

  it("rejects a finding whose title, detail, file, line or severity the reviewer never gave", () => {
    const one = (f: Record<string, unknown>) => evaluateRecoveryReply(envelope({ findings: [finding(f)] }), ctx)
    expect(one({ title: "SQL injection in the login form" })).toMatchObject({ kind: "invalid", reason: /title/ })
    expect(one({ detail: "this lets an attacker read every row" })).toMatchObject({ kind: "invalid", reason: /detail/ })
    expect(one({ file: "src/other.ts" })).toMatchObject({ kind: "invalid", reason: /never mentions/ })
    expect(one({ line: 99 })).toMatchObject({ kind: "invalid", reason: /line 99/ })
    expect(one({ line: undefined, file: undefined })).toMatchObject({ kind: "recovered" })
    expect(one({ file: undefined })).toMatchObject({ kind: "invalid", reason: /line without a file/ })
  })

  it("does not accept a bare basename elsewhere in the output as grounding for a different path", () => {
    expect(evaluateRecoveryReply(envelope({ findings: [finding({ file: "packages/core/src/a.ts" })] }), ctx)).toMatchObject({ kind: "invalid" })
  })

  it("keeps the reviewer's severity: a severity word the reviewer never wrote near the finding is rejected", () => {
    const e = { ...ctx, evidence: "The loop never terminates when the list is empty. It is minor, at src/a.ts:3." }
    expect(evaluateRecoveryReply(envelope(), e)).toMatchObject({ kind: "invalid", reason: /severity 'high'/ })
  })

  it("requires a finding at or above the lane's blocking severity (a sub-blocking block would fold to PASS)", () => {
    const e = { ...ctx, evidence: EVIDENCE.replace("high", "low") }
    const reply = envelope({ findings: [finding({ severity: "low" })] })
    expect(evaluateRecoveryReply(reply, e)).toMatchObject({ kind: "invalid", reason: /blocking severity/ })
    expect(evaluateRecoveryReply(reply, { ...e, blockOn: "low" })).toMatchObject({ kind: "recovered" })
  })

  it("grounds only in the reviewer's prose, not in error or tool-result marker lines", () => {
    const e = { ...ctx, evidence: "[tool-error] The loop never terminates when the list is empty. high src/a.ts:3" }
    expect(evaluateRecoveryReply(envelope(), e)).toMatchObject({ kind: "invalid" })
  })

  it("still lifts a block from a failed turn", () => {
    expect(evaluateRecoveryReply(envelope(), { ...ctx, lifecycle: "errored" })).toMatchObject({ kind: "recovered" })
  })

  it("only honours needs_followup when a follow-up is possible and the turn was clean", () => {
    const reply = JSON.stringify({ status: "needs_followup", reason: "no conclusion" })
    expect(evaluateRecoveryReply(reply, ctx)).toMatchObject({ kind: "followup" })
    expect(evaluateRecoveryReply(reply, { ...ctx, followUpPossible: false })).toMatchObject({ kind: "classified", outcome: "insufficient_evidence" })
    expect(evaluateRecoveryReply(reply, { ...ctx, lifecycle: "errored" })).toMatchObject({ kind: "classified", outcome: "insufficient_evidence" })
  })

  it("classifies insufficient_evidence / reviewer_failed and survives garbage", () => {
    expect(evaluateRecoveryReply(JSON.stringify({ status: "reviewer_failed", reason: "no repo access" }), ctx)).toEqual({
      kind: "classified",
      outcome: "reviewer_failed",
      reason: "no repo access",
    })
    expect(evaluateRecoveryReply("sure, I approve!", ctx)).toMatchObject({ kind: "invalid" })
    expect(evaluateRecoveryReply(JSON.stringify({ status: "approve" }), ctx)).toMatchObject({ kind: "invalid" })
  })
})

const text = (t: string) => ({ kind: "text-delta", text: t })
const APPROVE = JSON.stringify({ decision: "approve", summary: "No issues found.", findings: [] })
const BLOCK = JSON.stringify({
  decision: "request_changes",
  summary: "inverted check",
  findings: [{ severity: "high", title: "Inverted null check", detail: "crashes", file: "src/x.ts", line: 4 }],
})
const rx = { blockOn: "high" as const, lifecycle: "clean" as const }

describe("analyzeReviewerTranscript", () => {
  it("keeps only assistant text since the last prompt and notes the turn end", () => {
    const t = analyzeReviewerTranscript([
      { kind: "user-prompt", text: "review" },
      text("old turn\n"),
      { kind: "turn-end", reason: "end_turn" },
      { kind: "user-prompt", text: "follow-up" },
      { kind: "thought", text: "hidden\n" },
      { kind: "tool-result", result: APPROVE },
      text("new turn\n"),
      { kind: "turn-end", reason: "error" },
    ])
    expect(t).toEqual({ assistantText: "new turn\n", turnEnded: true, turnReason: "error" })
  })

  it("reports an unfinished turn (no turn-end record yet) as not ended", () => {
    expect(analyzeReviewerTranscript([text("partial")]).turnEnded).toBe(false)
  })
})

describe("extractExplicitReport", () => {
  it("lifts a complete verdict from raw JSON or a fence in assistant text, preserving findings exactly", () => {
    const r = extractExplicitReport(`Done.\n\`\`\`json\n${BLOCK}\n\`\`\`\nThat is all.`, rx)
    expect(r).toMatchObject({ kind: "report", report: { decision: "request_changes", findings: [{ severity: "high", title: "Inverted null check", file: "src/x.ts", line: 4 }] } })
    expect(extractExplicitReport(`Final: ${APPROVE}`, rx)).toMatchObject({ kind: "report", report: { decision: "approve" } })
  })

  it("is not fooled by braces in strings or surrounding prose", () => {
    const tricky = JSON.stringify({ decision: "approve", summary: "handles } and { in text", findings: [] })
    expect(extractExplicitReport(`Use {x} here. ${tricky} {not json`, rx)).toMatchObject({ kind: "report" })
  })

  it("ignores prose conclusions, incomplete JSON, a missing findings array and the prompt's template", () => {
    expect(extractExplicitReport("I reviewed everything. Verdict: approve, nothing needs changing.", rx)).toEqual({ kind: "none" })
    expect(extractExplicitReport('{"decision":"approve","summary":"ok"}', rx)).toEqual({ kind: "none" })
    expect(extractExplicitReport('{"decision":"approve","findings":[', rx)).toEqual({ kind: "none" })
    const template = '{"decision":"request_changes","summary":"<one line>","findings":[{"severity":"high","title":"<one line>","detail":"<why it matters>","file":"<repo-relative path>","line":42}]}'
    expect(extractExplicitReport(template, rx)).toEqual({ kind: "none" })
  })

  it("rejects a self-contradictory verdict and an empty request_changes", () => {
    const contradictory = JSON.stringify({ decision: "approve", findings: [{ severity: "high", title: "bad" }] })
    expect(extractExplicitReport(contradictory, rx)).toEqual({ kind: "none" })
    expect(extractExplicitReport('{"decision":"request_changes","findings":[]}', rx)).toEqual({ kind: "none" })
  })

  it("treats two different verdicts as a conflict and identical repeats as one", () => {
    expect(extractExplicitReport(`${APPROVE}\nActually: ${BLOCK}`, rx)).toMatchObject({ kind: "conflict" })
    expect(extractExplicitReport(`${BLOCK}\n${BLOCK}`, rx)).toMatchObject({ kind: "report" })
  })

  it("never accepts an approval from a failed turn, but does accept a block", () => {
    const failed = { ...rx, lifecycle: "errored" as const }
    expect(extractExplicitReport(APPROVE, failed)).toMatchObject({ kind: "none", note: expect.stringMatching(/failed turn/) })
    expect(extractExplicitReport(BLOCK, failed)).toMatchObject({ kind: "report" })
  })
})

describe("buildRecoveryPrompt", () => {
  it("frames the output as untrusted data and forbids approving, a second review and guessing", () => {
    const p = buildRecoveryPrompt({ laneId: "correctness", blockOn: "high", evidence: "X", lifecycle: "errored", lifecycleDetail: "401", followUpPossible: false })
    expect(p).toMatch(/untrusted data/)
    expect(p).toMatch(/NEVER approve/)
    expect(p).toMatch(/never add a finding/)
    expect(p).toMatch(/Uncertainty is not approval/)
    expect(p).toMatch(/turn FAILED \(401\)/)
    expect(p).not.toMatch(/needs_followup/)
    expect(p).not.toMatch(/"approve"/)
  })

  it("offers needs_followup only when a follow-up is possible", () => {
    const p = buildRecoveryPrompt({ laneId: "c", blockOn: "high", evidence: "X", lifecycle: "clean", followUpPossible: true })
    expect(p).toMatch(/needs_followup/)
  })
})

describe("buildFollowUpPrompt", () => {
  it("names the path, refuses uncertainty-as-approval, and says why for a conflict", () => {
    expect(buildFollowUpPrompt("/tmp/v.json")).toMatch(/\/tmp\/v\.json[\s\S]*uncertainty is not approval/)
    expect(buildFollowUpPrompt("/tmp/v.json", "conflict")).toMatch(/conflicting/)
  })
})
