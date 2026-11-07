// Entry-based handle for the SUPERVISED PR-review lane.
//
// Replaces the single-step review with ONE supervised workflow:
//
//   review ─▶ changes requested? ─▶ fix ─▶ re-review ─┐
//      ▲                                              │
//      └──────────── until approved ─────────────────┘
//
// bounded by `maxFixIterations` from `.github/agentic-review.json` (read once
// at module load, below). The reviewer and the fixer both run on the CI
// checkout as HOST sessions, children of the supervisor session the
// `agentproto-run` action passes to `workflow_run_file` - that is what makes
// the tree read as ONE supervisor with reviewer/fixer children instead of
// anonymous depth-0 roots.
//
// Why HOST placement for both: `fixDelivery` is `commit` - the agents only
// write the working tree, and the CALLING JOB commits + pushes. A re-review
// must see the fixer's uncommitted edits, which a fresh sandbox clone of
// `pull/<n>/head` never would. The fixer's lane already runs on the host
// (`review-fix`), so this is the same proven spawn path.
//
// The review step declares an `outputSchema`, so its verdict is a typed STEP
// OUTPUT the loop condition can read (`$steps.review.output.conclusion`)
// instead of a heuristic over prose. An unparseable verdict fails the step -
// never a silent approval.

import { readFileSync } from "node:fs"
import {
  adapterFor,
  changesetRulesBlock,
  hardRulesBlock,
  reviewerModelFor,
  reviewerTurnRetryFor,
} from "../lib/sandbox-agent.mjs"
import {
  buildReviewSummary,
  stageDiagram,
} from "../../../scripts/lib/review-run-summary.mjs"

/** `.github/agentic-review.json` lives two levels up from this entry. */
const REVIEW_CONFIG_URL = new URL("../../agentic-review.json", import.meta.url)

const readReviewConfig = () => {
  try {
    return JSON.parse(readFileSync(REVIEW_CONFIG_URL, "utf8"))
  } catch {
    return {}
  }
}

const reviewConfigFile = readReviewConfig()

/** `commands.fix.maxFixIterations` → `maxFixIterations` → 3, non-negative int. */
export const resolveMaxFixIterations = (config = reviewConfigFile) => {
  const raw = config?.commands?.fix?.maxFixIterations ?? config?.maxFixIterations
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : 3
}

export const maxFixIterations = resolveMaxFixIterations()

// The loop body is [review, branch -> fix, fix]: each iteration is ONE review
// followed by AT MOST one fix round. The loop is therefore capped at
// `maxFixIterations` iterations (0 = review-only), and a trailing review-only
// step (outside the loop) runs when the loop exhausted its budget without an
// approve. That guarantees at most `maxFixIterations` fixes, each followed by
// a re-review, and the last fix is always re-reviewed.
export const maxReviewIterations = maxFixIterations
export const maxTotalReviews = maxFixIterations + 1

/**
 * The typed verdict every `review` step must end with. Hand-written
 * `safeParse` (not zod - this file runs from `.github/`, where zod is not
 * resolvable); `jsonSchema` renders the same contract into the prompt.
 */
export const reviewVerdictSchema = {
  jsonSchema: {
    type: "object",
    required: ["conclusion", "summary"],
    properties: {
      conclusion: { type: "string", enum: ["approve", "request_changes"] },
      summary: { type: "string" },
      findings: {
        type: "array",
        items: {
          type: "object",
          required: ["note"],
          properties: {
            severity: { type: "string", enum: ["high", "medium", "low"] },
            file: { type: "string" },
            note: { type: "string" },
          },
        },
      },
    },
    additionalProperties: true,
  },
  safeParse(value) {
    const ok =
      value !== null &&
      typeof value === "object" &&
      (value.conclusion === "approve" || value.conclusion === "request_changes") &&
      typeof value.summary === "string"
    if (ok) return { success: true, data: value }
    return {
      success: false,
      error: {
        issues: [
          {
            path: ["conclusion", "summary"],
            message:
              'expected { "conclusion": "approve" | "request_changes", "summary": string, "findings"?: [...] }',
          },
        ],
      },
    }
  },
}

export { buildReviewSummary, stageDiagram }

/** Per-verb config merged over the global config (same as `agent-core`). */
const commandConfig = (config, verb) => {
  const base = { ...(config || {}) }
  delete base.commands
  return { ...base, ...(config?.commands?.[verb] ?? {}) }
}

/** The fixer keeps its own model override when the config declares one. */
export const fixerModelFor = (config) => {
  const m = commandConfig(config, "fix").reviewerModel
  return typeof m === "string" && m.trim() ? m.trim() : reviewerModelFor(config, "review")
}

const IMPERATIVE_VERDICT =
  'End your turn with ONLY a JSON object matching the verdict schema above - no prose, no markdown fence. The workflow reads that JSON as the step output; a review that does not end with it is treated as a missing output.'

/** Was this an incremental pass (a prior review + a fix already ran)? */
const priorReview = (bindings) => {
  const value = bindings?.steps?.review?.output
  return value && typeof value === "object" ? value : undefined
}

const reviewPrompt = (bindings) => {
  const {
    prNumber,
    baseRef = "main",
    repo = "",
    reviewConfig = {},
    lastReviewedSha = "",
    priorReviewBody = "",
  } = bindings?.input ?? {}
  const cfg = reviewConfig || {}
  const blocking = cfg.blocking ?? true
  const botMention = cfg.botMention ?? "@agentproto-bot"
  const escalateGlobs = cfg.merge?.alwaysEscalateGlobs ?? []

  const prior = priorReview(bindings)
  const fixed = bindings?.steps?.fix !== undefined
  const incremental = Boolean(prior) && fixed
  const firstPass = !incremental

  const incrementalBlock = incremental
    ? [
        `## Re-review after a fix (IMPORTANT)`,
        ``,
        `A previous pass of THIS run requested changes and the fixer then edited the`,
        `working tree (uncommitted - the calling job commits and pushes after this`,
        `run). Re-review the working tree, not just the last commit:`,
        ``,
        `- \`git diff origin/${baseRef}...HEAD\` - the PR as pushed.`,
        `- \`git diff\` and \`git status --porcelain\` - the fixer's UNCOMMITTED edits.`,
        `- Focus on whether the prior findings are resolved; do not re-raise findings`,
        `  that the fix addressed, and do not invent new scope.`,
        ``,
        `Prior verdict from this run:`,
        `\`\`\`json`,
        JSON.stringify(prior, null, 2),
        `\`\`\``,
        ``,
      ].join("\n")
    : lastReviewedSha && lastReviewedSha !== "HEAD"
      ? [
          `## Incremental review`,
          ``,
          `You have ALREADY reviewed this PR through commit \`${lastReviewedSha}\` in an`,
          `earlier run. Review the increment (\`git diff ${lastReviewedSha}...HEAD\`); use`,
          `the full \`git diff origin/${baseRef}...HEAD\` only for context.`,
          priorReviewBody && priorReviewBody.trim()
            ? [``, `Your previous review (for reference):`, ``, `<<<PRIOR_REVIEW`, priorReviewBody.trim(), `PRIOR_REVIEW`].join("\n")
            : ``,
          ``,
        ].join("\n")
      : ""

  const changesetBlock = firstPass
    ? [
        `## Changeset (first pass only)`,
        ``,
        `Run \`node scripts/list-changed-packages.mjs\` - it prints the exact`,
        `\`package.json\` name of every workspace package this PR changed, one per`,
        `line. If it prints nothing, no changeset is owed. If the branch already`,
        `adds a changeset declaring every one of those packages, write none.`,
        `Otherwise write ONE changeset file at \`.changeset/pr-${prNumber}-agentic.md\``,
        `with ONE frontmatter block listing every package, then describe the change.`,
        ``,
        changesetRulesBlock(),
        ``,
      ].join("\n")
    : ""

  return [
    `You are an expert code reviewer for the @agentproto/ts monorepo - a TypeScript implementation of open agent standards (AIPs).`,
    ``,
    `Your job: review PR #${prNumber}${repo ? ` (${repo})` : ""} and post ONE structured GitHub review. This is pass ${firstPass ? "1" : "2+"} of a supervised review/fix loop; the supervisor session is your parent.`,
    ``,
    incrementalBlock,
    `## Phase 1: Analyze`,
    ``,
    `1. \`git diff origin/${baseRef}...HEAD\` - what the PR changed.`,
    `2. Read the changed files and follow references/call-sites (read_file, grep).`,
    `3. Identify correctness, type safety, AIP alignment, test coverage, and whether a changeset is needed.`,
    ``,
    `## Phase 2: Post the review (host placement - \`gh\` is authenticated)`,
    ``,
    `1. Post the review with \`gh pr review ${prNumber} <flag> --body "<markdown>"\`, where`,
    `   \`<flag>\` follows the verdict DETERMINISTICALLY:`,
    `   - \`--approve\` when your verdict is approve (low-severity findings stay under an approve),`,
    `   - \`--request-changes\` ONLY for real correctness problems (bugs, broken contracts, security),`,
    `   - \`--comment\` NEVER for a final verdict - GitHub does not count it as an approval.`,
    `   Body format: \`## Summary\`, \`## Changeset\`, \`## Findings\`, \`## Verdict\`.`,
    `   Do NOT add a signature: CI stamps a deterministic \`${botMention}\` provenance footer.`,
    ``,
    changesetBlock,
    `## Phase 3: Report the verdict`,
    ``,
    IMPERATIVE_VERDICT,
    ``,
    `- \`conclusion\`: "approve" | "request_changes"`,
    `- \`summary\`: one line.`,
    `- \`findings\`: every actionable finding, each with \`severity\`, \`file\`, \`note\`.`,
    `  Empty on an approve with nothing worth mentioning.`,
    ``,
    `Blocking mode is ${blocking}: a request_changes verdict fails the merge gate.`,
    escalateGlobs.length > 0
      ? `Sensitive paths (be extra careful, review normally): ${escalateGlobs.join(", ")}.`
      : "",
    ``,
    hardRulesBlock({
      sandboxed: false,
      extra: [
        `- Keep exploration tight - posting the review is the most important action.`,
        `- Do NOT commit or push: the calling job owns delivery (\`fixDelivery: commit\`).`,
      ],
    }),
  ]
    .filter(Boolean)
    .join("\n")
}

const fixPrompt = (bindings) => {
  const { prNumber, baseRef = "main", repo = "" } = bindings?.input ?? {}
  const verdict = bindings?.steps?.review?.output ?? {}
  const findings = Array.isArray(verdict.findings) ? verdict.findings : []

  return [
    `You are a senior engineer for the @agentproto/ts monorepo. You are the FIXER child`,
    `of a supervised review run for PR #${prNumber}${repo ? ` (${repo})` : ""}.`,
    ``,
    `The reviewer (your sibling step in this same run) requested changes with these findings:`,
    ``,
    `\`\`\`json`,
    JSON.stringify(findings, null, 2),
    `\`\`\``,
    ``,
    `Reviewer summary: ${verdict.summary ?? "(none)"}`,
    ``,
    `## Apply the fixes`,
    ``,
    `1. Read the PR context you need with \`gh pr view ${prNumber}\` and`,
    `   \`git diff origin/${baseRef}...HEAD\` - but ground every edit in the actual code.`,
    `2. Make the MINIMAL edits that resolve every actionable finding. No unrelated`,
    `   refactors, no reformatting, no scope creep.`,
    `3. Add or adjust tests where the findings call for coverage.`,
    `4. Verify cheaply where feasible (type-check the touched package / run its tests).`,
    `   Do not install the world.`,
    ``,
    `## Stop`,
    ``,
    `- Leave the changes in the WORKING TREE. Do NOT commit, do NOT push, do NOT open`,
    `  a PR, do NOT post a review or comment. The calling job commits and pushes.`,
    `- Never run \`gh pr merge\`.`,
    `- Finish with a short bullet list of the files you changed and why.`,
    ``,
    hardRulesBlock({ sandboxed: false }),
  ].join("\n")
}

const reviewStep = {
  kind: "agent",
  id: "review",
  adapter: (b) => adapterFor(b?.input?.reviewConfig, "review"),
  model: (b) => reviewerModelFor(b?.input?.reviewConfig, "review"),
  // HOST session: no placement ladder (that is the box lanes' job), but the
  // same usage-limit / rate-limit fallback as the box path, read from the same
  // `reviewerTurnRetry` through the same lib helper.
  turnRetry: (b) => reviewerTurnRetryFor(b?.input?.reviewConfig, "review"),
  prompt: reviewPrompt,
  outputSchema: reviewVerdictSchema,
}

const fixStep = {
  kind: "agent",
  id: "fix",
  adapter: (b) => adapterFor(b?.input?.reviewConfig, "fix"),
  model: (b) => fixerModelFor(b?.input?.reviewConfig),
  turnRetry: (b) => reviewerTurnRetryFor(b?.input?.reviewConfig, "fix"),
  prompt: fixPrompt,
}

export const supervisedReviewStep = {
  kind: "loop",
  id: "supervised-review",
  while: "$steps.review.output.conclusion != approve",
  max_iterations: maxReviewIterations,
  steps: [
    reviewStep,
    {
      kind: "branch",
      id: "needs-fix",
      branches: [
        { when: "$steps.review.output.conclusion == request_changes", next: "fix" },
      ],
      // `fix` is the last sibling, so the join is the end of the body.
    },
    fixStep,
  ],
}

// When the loop exhausted its fix budget without approving, one final
// review-only pass judges the last fix. It is skipped when the loop already
// approved. It reuses the `review` step id so the prompts and the summary
// builder see it exactly like any other review execution.
export const finalReviewBranch = {
  kind: "branch",
  id: "needs-final-review",
  branches: [
    { when: "$steps.review.output.conclusion != approve", next: "review" },
  ],
}

export { fixPrompt, reviewPrompt }

export default {
  name: "Agentproto PR Review (supervised)",
  id: "agentproto-pr-review-supervised",
  description:
    "One supervised review loop: review, then (on changes requested) fix the working tree and re-review, bounded by maxFixIterations. Reviewer and fixer are children of the supervisor session the runner passes in.",
  version: "0.1.0",
  inputs: {
    prNumber: {
      type: "number",
      description: "The pull request number to review.",
      default: 0,
    },
    baseRef: { type: "string", description: "Base branch ref.", default: "main" },
    repo: {
      type: "string",
      description: "owner/repo slug (for prompts and API links).",
      default: "",
    },
    lastReviewedSha: {
      type: "string",
      description: "SHA the reviewer last posted a review against; empty on first review.",
      default: "",
    },
    priorReviewBody: {
      type: "string",
      description: "The markdown body of the reviewer's prior review, for continuity.",
      default: "",
    },
    githubToken: { type: "string", description: "GitHub token for posting reviews." },
    anthropicApiKey: {
      type: "string",
      description: "Fallback API key (not used by this workflow, passed for compatibility).",
    },
    reviewConfig: {
      type: "object",
      description: "Parsed .github/agentic-review.json config.",
      default: {},
    },
  },
  outputs: {
    conclusion: { type: "string", description: "approved | changes_requested | comment" },
    reviewBody: { type: "string", description: "The markdown review body posted." },
    changesetWritten: { type: "boolean", description: "Whether a changeset was written." },
    error: { type: "string", description: "Error message if the review failed." },
  },
  steps: [supervisedReviewStep, finalReviewBranch, reviewStep],
}
