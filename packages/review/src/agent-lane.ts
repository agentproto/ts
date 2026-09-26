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
}

/** Build the reviewer session's prompt. Pure string assembly — the host
 *  resolves both paths. */
export function buildAgentLanePrompt(input: AgentLanePromptInput): string {
  const { reviewId, check, target, rubricPath, verdictPath } = input
  const range = `${target.baseSha}..${target.headSha}`
  const budgetMin = Math.max(1, Math.round((check.timeoutMs / 60_000) * 0.8))
  return [
    `You are review lane '${check.id}' of review '${reviewId}'. Review the committed git range ${range} in this repository.`,
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
    `When done, write EXACTLY ONE file — ${verdictPath} — containing ONLY this JSON (no markdown fence):`,
    `{ "decision": "approve" | "request_changes", "summary": "<one line>", "findings": [{ "severity": "high" | "medium" | "low", "title": "<one line>", "detail": "<why it matters>", "file": "<repo-relative path>", "line": <number> }] }`,
    "",
    `Severity semantics: this lane blocks on any "${check.blockOn}"-or-higher finding. Reserve "high" for real correctness or security regressions INTRODUCED by this range; pre-existing issues and nits are "medium"/"low". An empty "findings" array means you found nothing.`,
  ].join("\n")
}
