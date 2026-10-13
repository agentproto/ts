/**
 * The agent-lane contract: what a reviewer session is told, and what it must
 * write back.
 *
 * Pointer-style, not diff-serialized: the reviewer gets the RANGE and the
 * rubric's PATH and reads the repo at its own pace (whole files, callers,
 * tests) — there is no diff to cap, so no silent truncation. Its verdict is a
 * structured JSON file at a host-chosen path (outside the reviewed tree),
 * validated here; a missing or malformed file makes the lane `skipped`, never
 * a pass.
 */

import { z } from "zod"
import type { Finding, ReviewTarget } from "./types.js"
import type { AgentCheck } from "./manifest.js"

export const agentLaneReportSchema = z.object({
  decision: z.enum(["approve", "request_changes"]).optional(),
  summary: z.string().optional(),
  findings: z.array(
    z.object({
      severity: z.enum(["high", "medium", "low"]),
      title: z.string().min(1),
      detail: z.string().optional(),
      file: z.string().optional(),
      line: z.number().int().positive().optional(),
    }),
  ),
})

export interface AgentLaneReport {
  decision?: "approve" | "request_changes"
  summary?: string
  findings: Finding[]
}

export class AgentLaneReportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AgentLaneReportError"
  }
}

/** Parse + validate the JSON a reviewer wrote to its verdict file. Tolerates
 *  a surrounding markdown fence (models add one despite being told not to).
 *  Throws {@link AgentLaneReportError}. */
export function parseAgentLaneReport(raw: string): AgentLaneReport {
  const unfenced = raw
    .trim()
    .replace(/^```(?:json)?\s*\n/, "")
    .replace(/\n```\s*$/, "")
  let json: unknown
  try {
    json = JSON.parse(unfenced)
  } catch (err) {
    throw new AgentLaneReportError(
      `verdict file is not valid JSON — ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const result = agentLaneReportSchema.safeParse(json)
  if (!result.success) {
    throw new AgentLaneReportError(
      `verdict file does not match the lane contract — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  const r = result.data
  return {
    ...(r.decision !== undefined ? { decision: r.decision } : {}),
    ...(r.summary !== undefined ? { summary: r.summary } : {}),
    findings: r.findings.map((f) => ({
      severity: f.severity,
      title: f.title,
      detail: f.detail ?? "",
      ...(f.file !== undefined ? { file: f.file } : {}),
      ...(f.line !== undefined ? { line: f.line } : {}),
    })),
  }
}

export interface AgentLanePromptInput {
  reviewId: string
  check: AgentCheck
  target: ReviewTarget
  /** Absolute path of the rubric file the reviewer must read. */
  rubricPath: string
  /** Absolute path the reviewer must write its verdict JSON to. */
  verdictPath: string
  /** Set when this lane is a DELTA re-review composed onto a prior passing
   *  attestation: `target` is already narrowed to `priorHeadSha..head`, and
   *  this names the commit everything before it was already reviewed and
   *  passed — told to the reviewer explicitly rather than left implicit in
   *  the range alone. */
  composedFrom?: { priorHeadSha: string }
}

/** Build the reviewer session's prompt. Pure string assembly — the host
 *  resolves both paths. */
export function buildAgentLanePrompt(input: AgentLanePromptInput): string {
  const { reviewId, check, target, rubricPath, verdictPath, composedFrom } = input
  const range = `${target.baseSha}..${target.headSha}`
  const budgetMin = Math.max(1, Math.round((check.timeoutMs / 60_000) * 0.8))
  return [
    `You are review lane '${check.id}' of review '${reviewId}'. Review the committed git range ${range} in this repository.`,
    ...(composedFrom
      ? [
          "",
          `This is a DELTA re-review: everything up to and including ${composedFrom.priorHeadSha} already passed this lane in an earlier review. Review ONLY what changed in ${range} — you do not need to re-review commits before ${composedFrom.priorHeadSha}.`,
        ]
      : []),
    "",
    `Your rubric — what to look for and how to grade it — is at ${rubricPath}. Read it first; it overrides any general reviewing habits.`,
    "",
    "How to work:",
    `- Scope is the committed range only: \`git diff ${range}\`, \`git log ${range}\`, and whatever files those touch. Ignore uncommitted or untracked changes in the working tree.`,
    "- Read whole files, callers, and neighbors — never judge from a hunk alone. Verify every claim against the file on disk.",
    "- Run the touched packages' tests or type-checks if the rubric asks for it or a finding depends on it.",
    "- READ-ONLY: do not edit, commit, push, or switch branches. Your only permitted write is the verdict file below.",
    `- Time budget: about ${budgetMin} minute(s). Depth on the riskiest changes beats shallow coverage of all of them.`,
    "",
    `When done, write EXACTLY ONE file — ${verdictPath} — containing ONLY the verdict as raw JSON (no markdown fence, no text around it), shaped exactly like this example:`,
    `{"decision":"request_changes","summary":"<one line>","findings":[{"severity":"high","title":"<one line>","detail":"<why it matters>","file":"<repo-relative path>","line":42}]}`,
    `"severity" is "high", "medium" or "low"; "file" and "line" (a positive integer) are optional. Write the file as your LAST action. The file IS your verdict: a conclusion stated only in chat is not submitted and is lost.`,
    "",
    "One rule for the verdict:",
    `- Only your "findings" decide the outcome: this lane blocks on any "${check.blockOn}"-or-higher finding. "decision" restates it — "request_changes" when you list at least one finding, "approve" only when you list no finding at or above "${check.blockOn}". Never "request_changes" with an empty "findings" array (nothing would block), and never "approve" next to a blocking finding.`,
    `- Severity: reserve "high" for real correctness or security regressions INTRODUCED by this range; pre-existing issues and nits are "medium"/"low". A change the range makes ON PURPOSE (an intended API or behavior change its commit message, changelog or updated tests describe) is not a regression — flag it only if callers, tests or docs were left inconsistent with it.`,
    `- An empty "findings" array with "approve" means you reviewed the whole range and found nothing.`,
    `- Uncertainty is not approval. If you could not finish (out of budget, unreadable range, failing tools), do not write "approve": record what you verified as findings and say in "summary" what you could not cover — or, if you could not review at all, write no file and say why in chat (the lane is then reported incomplete, never passed).`,
  ].join("\n")
}
