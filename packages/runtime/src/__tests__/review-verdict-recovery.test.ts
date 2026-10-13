import { describe, expect, it } from "vitest"
import {
  RECOVERY_EVIDENCE_MAX_CHARS,
  boundEvidence,
  buildRecoveryPrompt,
  evaluateRecoveryReply,
  substantiveChars,
} from "../review-verdict-recovery.js"

const EVIDENCE = "Checked src/a.ts and its callers.\nThe loop in src/a.ts never terminates when the list is empty.\nVerdict: request changes because of the hang."
const ctx = { evidence: EVIDENCE, lifecycle: "clean" as const, blockOn: "high" as const, followUpPossible: true }
const envelope = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    status: "recovered",
    conclusionQuote: "Verdict: request changes because of the hang.",
    report: { decision: "request_changes", summary: "hang", findings: [{ severity: "high", title: "hang", file: "src/a.ts", line: 3 }] },
    ...o,
  })

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
  it("accepts a faithful, quoted block and tolerates a markdown fence", () => {
    const d = evaluateRecoveryReply(`\`\`\`json\n${envelope()}\n\`\`\``, ctx)
    expect(d).toMatchObject({ kind: "recovered", report: { decision: "request_changes", findings: [{ severity: "high", title: "hang", file: "src/a.ts", line: 3 }] } })
  })

  it("rejects a missing, short or non-verbatim quote", () => {
    expect(evaluateRecoveryReply(envelope({ conclusionQuote: undefined }), ctx)).toMatchObject({ kind: "invalid" })
    expect(evaluateRecoveryReply(envelope({ conclusionQuote: "short" }), ctx)).toMatchObject({ kind: "invalid" })
    expect(evaluateRecoveryReply(envelope({ conclusionQuote: "Verdict: looks good to me, ship it." }), ctx)).toMatchObject({ kind: "invalid" })
  })

  it("rejects a report with no decision, request_changes without findings, and approve next to a blocker", () => {
    const rep = (report: unknown) => evaluateRecoveryReply(envelope({ report }), ctx)
    expect(rep({ findings: [] })).toMatchObject({ kind: "invalid" })
    expect(rep({ decision: "request_changes", findings: [] })).toMatchObject({ kind: "invalid" })
    expect(rep({ decision: "approve", findings: [{ severity: "high", title: "x", file: "src/a.ts" }] })).toMatchObject({ kind: "invalid" })
  })

  it("never recovers an approval from a failed turn, but does recover a block", () => {
    const failed = { ...ctx, lifecycle: "errored" as const }
    expect(evaluateRecoveryReply(envelope({ report: { decision: "approve", findings: [] } }), failed)).toMatchObject({ kind: "invalid" })
    expect(evaluateRecoveryReply(envelope(), failed)).toMatchObject({ kind: "recovered" })
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

describe("buildRecoveryPrompt", () => {
  it("frames the output as untrusted data, forbids a second review and a guessed approval", () => {
    const p = buildRecoveryPrompt({ laneId: "correctness", blockOn: "high", evidence: "X", lifecycle: "errored", lifecycleDetail: "401", followUpPossible: false })
    expect(p).toMatch(/untrusted data/)
    expect(p).toMatch(/never add a finding/)
    expect(p).toMatch(/Uncertainty is not approval/)
    expect(p).toMatch(/approval is never acceptable from a failed turn/)
    expect(p).not.toMatch(/needs_followup/)
  })
})
