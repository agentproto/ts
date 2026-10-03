/**
 * Agreement harness for the rewritten wrap-up criteria (mission PR 3, point
 * 11): score a DETERMINISTIC, criteria-faithful stub judge over the real
 * fixtures, once on the OLD evidence shape + OLD vague criteria (v1) and once
 * on the ENRICHED evidence + concrete criteria (v2), and report the
 * before/after agreement with the operator ground truth.
 *
 * Why a stub, not Jev: Jev is a live paid API and is not callable in CI. The
 * stub encodes exactly the concrete signals the rewritten
 * `WRAPUP_VERDICT_CRITERIA` names (merged PR, `message_parent(kind:done)`,
 * `outcome.verdict`, 0/0 tokens, a question as the last turn, live children),
 * so this pins that those signals actually separate the real cases. It is a
 * regression harness, not a measurement of Jev's live accuracy.
 */

import { describe, it, expect } from "vitest"
import { WRAPUP_VERDICT_CRITERIA } from "../jev-client.js"
import { VERDICT_FIXTURES, type Verdict } from "./fixtures/session-steward-verdict-fixtures.js"

function lastAssistantText(e: Record<string, unknown>): string {
  const turns = e?.turns
  if (!Array.isArray(turns)) return ""
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i] as { role?: unknown; text?: unknown }
    if (t?.role === "assistant") return String(t.text ?? "")
  }
  return ""
}

const isQuestion = (text: string): boolean => /\?\s*$/.test(text.trim())

const looksLikeFinalReport = (text: string): boolean =>
  /(livraison|report done|auto-merge success|killed:|nudged:|PR #\d+\s+(OPEN|MERGED)|commit [0-9a-f]{6,})/i.test(text)

function normalize(v: string): Verdict {
  if (v === "partial" || v === "failed") return "abandoned"
  return v as Verdict
}

/** v1: the old evidence + the old vague criteria — only a merged/merged-
 *  signal or `awaitingInput` is decidable; everything else defaults active. */
export function stubJudgeV1(e: Record<string, unknown>): Verdict {
  const pr = (e?.worktree as { pr?: { state?: string } } | undefined)?.pr?.state
  const signals = (e?.signals ?? {}) as { worktreeMerged?: unknown }
  if (pr === "merged" || signals.worktreeMerged === true) return "done"
  if (e?.awaitingInput === true) return "needs-input"
  return "active"
}

/** v2: the enriched evidence + the concrete signals in the rewritten
 *  `WRAPUP_VERDICT_CRITERIA`. */
export function stubJudgeV2(e: Record<string, unknown>): Verdict {
  const pr = (e?.worktree as { pr?: { state?: string } } | undefined)?.pr?.state
  const pull = e?.pullRequests as { merged?: number } | undefined
  if ((pull?.merged ?? 0) > 0 || pr === "merged") return "done"
  const outcome = e?.outcome as { verdict?: string } | undefined
  if (outcome?.verdict) return normalize(outcome.verdict)
  if (e?.tokensIn === 0 && e?.tokensOut === 0) return "abandoned"
  const last = e?.lastToolCall as { tool?: string; kind?: string; command?: string } | undefined
  if (last && String(last.tool ?? "").includes("message_parent") && /(^|[^a-z])done([^a-z]|$)/i.test(`${last.kind ?? ""} ${last.command ?? ""}`)) {
    return "done"
  }
  if (e?.awaitingInput === true || isQuestion(lastAssistantText(e))) return "needs-input"
  if (typeof e?.liveChildren === "number" && e.liveChildren > 0) return "blocked"
  if ((pr === "open" || pr === "OPEN") && looksLikeFinalReport(lastAssistantText(e))) return "done"
  return "active"
}

describe("session-steward — wrap-up criteria agreement (fixtures)", () => {
  it("every fixture names a real verdict and a source", () => {
    for (const f of VERDICT_FIXTURES) {
      expect(["done", "abandoned", "blocked", "needs-input", "active"]).toContain(f.expected)
      expect(f.source.length).toBeGreaterThan(0)
      expect(f.why.length).toBeGreaterThan(0)
    }
    // The rewritten criteria cover exactly the five verdicts.
    expect(Object.keys(WRAPUP_VERDICT_CRITERIA).sort()).toEqual(["abandoned", "active", "blocked", "done", "needs-input"])
  })

  it("the enriched evidence + concrete criteria agree with ground truth at least as well as v1, and >= 0.9", () => {
    const v1Hits = VERDICT_FIXTURES.filter(f => stubJudgeV1(f.v1) === f.expected).length
    const v2Hits = VERDICT_FIXTURES.filter(f => stubJudgeV2(f.v2) === f.expected).length
    const total = VERDICT_FIXTURES.length
    const v1Rate = v1Hits / total
    const v2Rate = v2Hits / total
    // Report the numbers the mission asks for.
    console.log(
      `[steward-criteria] agreement with operator ground truth: ` +
        `before (v1 evidence+criteria) ${v1Hits}/${total} = ${(v1Rate * 100).toFixed(0)}%, ` +
        `after (v2 enriched evidence+concrete criteria) ${v2Hits}/${total} = ${(v2Rate * 100).toFixed(0)}%`,
    )
    expect(v2Hits).toBeGreaterThanOrEqual(v1Hits)
    expect(v2Rate).toBeGreaterThanOrEqual(0.9)
    expect(v2Rate).toBeGreaterThan(v1Rate)
  })
})
