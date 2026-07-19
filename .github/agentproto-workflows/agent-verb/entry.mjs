// Entry-based handle for the composable "sandboxed agentproto agent" verbs
// beyond review: `pr` (implement a request / an issue and open a PR) and
// `fix` (apply the latest review's requested changes). One parameterized
// workflow, not one workflow per verb — the sandbox machinery is
// command-agnostic (factored into ../lib/sandbox-agent.mjs, shared with
// pr-review/) and the ONLY per-verb variance is (prompt, delivery):
//
//   verb   prompt                                delivery
//   ────   ───────────────────────────────────   ─────────────────────────────
//   pr     implement `requestText` / issue       always a NEW PR (bot/… branch,
//                                                curl REST — box has no gh)
//   fix    apply latest review on PR #n          commands.fix.fixDelivery:
//                                                "pr" → stacked bot/fix-<n> PR
//                                                       based on the PR head
//                                                "commit" → push to the head
//                                                       branch directly
//
// Config source of truth: `.github/agentic-review.json` — global lane keys
// (reviewerAdapter/reviewerSandbox/reviewerSandboxEnv) + per-verb
// `commands.<verb>` overrides (skills, fixDelivery), resolved by the shared
// `resolveCommandConfig`.

import {
  adapterFor,
  bootstrapBlock,
  changesetRulesBlock,
  commitDeliveryBlock,
  hardRulesBlock,
  resolveCommandConfig,
  restOpenPrBlock,
  sandboxRefFor,
  skillsBlock,
  workspaceCwdFor,
} from "../lib/sandbox-agent.mjs"

const VERBS = new Set(["pr", "fix"])

const verbOf = (bindings) => {
  const v = String(bindings?.input?.verb || "").toLowerCase()
  // `implement` (issue flavor) is an alias of `pr` for config + prompting.
  return v === "implement" ? "pr" : v
}

const cfgOf = (bindings) => bindings?.input?.reviewConfig || {}

/** fixDelivery for the fix verb: commands.fix.fixDelivery > global > "pr". */
const fixDeliveryOf = (config) => {
  const d = resolveCommandConfig(config, "fix").fixDelivery
  return d === "commit" ? "commit" : "pr"
}

const taskBlock = (bindings) => {
  const verb = verbOf(bindings)
  const { prNumber, issueNumber, repo, requestText = "" } = bindings.input
  if (verb === "fix") {
    return [
      `## Phase 1: Understand the requested changes`,
      ``,
      `1. Fetch the latest reviews on PR #${prNumber}:`,
      `   \`curl -sS -H "Authorization: Bearer \${GITHUB_TOKEN}" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews?per_page=100"\``,
      `   Take the MOST RECENT review whose state is CHANGES_REQUESTED (or, absent one, the most recent COMMENTED review with actionable findings). Its body lists the findings to fix.`,
      `2. Ground every finding in the actual code (read the files, follow \`file:line\` references) before editing.`,
      ``,
      `## Phase 2: Apply the fixes`,
      ``,
      `1. Make the MINIMAL edits that resolve each finding. Do not refactor beyond what the review asks.`,
      `2. Add or adjust tests where the review calls for coverage.`,
      `3. Verify what you changed compiles/behaves where feasible (pnpm build/test of the touched package — skip if the toolchain install would dominate the task).`,
      `4. Write a changeset if a published package changed (file \`.changeset/pr-${prNumber}-fix.md\`).`,
      changesetRulesBlock(),
    ].join("\n")
  }
  // verb === "pr": implement a free-text request, or an issue.
  const target = issueNumber
    ? `GitHub issue #${issueNumber} — fetch it first: \`curl -sS -H "Authorization: Bearer \${GITHUB_TOKEN}" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/${repo}/issues/${issueNumber}"\` and read its body + comments`
    : `the request below`
  return [
    `## Phase 1: Understand`,
    ``,
    `1. Your task is to implement ${target}.`,
    ...(issueNumber ? [] : [``, `> **Request:** ${requestText || "(missing — say so in the PR body and stop)"}`]),
    ``,
    `2. Ground yourself in the actual code first (read files, grep). Only make changes required by the request — keep the diff tight.`,
    ``,
    `## Phase 2: Implement`,
    ``,
    `1. Implement the change end-to-end, with tests where behavior changed.`,
    `2. Verify what you changed where feasible (pnpm build/test of the touched package — skip if the toolchain install would dominate the task).`,
    `3. Write a changeset if a published package changed (file \`.changeset/${issueNumber ? `issue-${issueNumber}` : "bot-request"}-agentic.md\`).`,
    changesetRulesBlock(),
  ].join("\n")
}

const deliveryBlock = (bindings) => {
  const verb = verbOf(bindings)
  const { prNumber, issueNumber, repo, baseRef = "main", headRef = "" } = bindings.input
  if (verb === "fix") {
    if (fixDeliveryOf(cfgOf(bindings)) === "commit") {
      return [
        `## Phase 3: Deliver`,
        ``,
        commitDeliveryBlock({ branch: headRef || `pr-${prNumber}-head` }),
        headRef
          ? ""
          : `   (Resolve the PR head branch first: \`curl -sS -H "Authorization: Bearer \${GITHUB_TOKEN}" "https://api.github.com/repos/${repo}/pulls/${prNumber}"\` → \`.head.ref\`.)`,
      ].filter(Boolean).join("\n")
    }
    return [
      `## Phase 3: Deliver`,
      ``,
      restOpenPrBlock({
        repo,
        branch: `bot/fix-${prNumber}`,
        base: headRef || baseRef,
        titleHint: `PR #${prNumber}'s review`,
      }),
    ].join("\n")
  }
  return [
    `## Phase 3: Deliver`,
    ``,
    restOpenPrBlock({
      repo,
      branch: issueNumber ? `bot/issue-${issueNumber}` : `bot/request-${Date.now().toString(36)}`,
      base: baseRef,
      titleHint: issueNumber ? `closing #${issueNumber}` : "the triggering request",
    }),
  ].join("\n")
}

const verbPrompt = (bindings) => {
  const verb = verbOf(bindings)
  const cfg = cfgOf(bindings)
  const { prNumber, repo = "", baseRef = "main" } = bindings.input
  if (!VERBS.has(verb)) {
    // Defensive: an unknown verb must not silently act — instruct a no-op.
    return `Unknown agent verb "${bindings?.input?.verb}". Do nothing and reply with exactly: UNSUPPORTED VERB.`
  }
  const sandboxed = sandboxRefFor(cfg, verb) !== undefined && Boolean(repo)
  return [
    `You are a senior engineer for the @agentproto/ts monorepo — a TypeScript implementation of open agent standards (AIPs).`,
    ``,
    verb === "fix"
      ? `Your job: apply the latest review's requested changes on PR #${prNumber} and deliver them.`
      : `Your job: implement the requested change end-to-end and deliver it as a pull request.`,
    ``,
    sandboxed ? bootstrapBlock({ repo, baseRef, prNumber: verb === "fix" ? prNumber : undefined }) : "",
    skillsBlock(cfg, verb),
    taskBlock(bindings),
    ``,
    deliveryBlock(bindings),
    ``,
    hardRulesBlock({
      sandboxed,
      extra: [
        `- Never push to \`${baseRef}\` directly — deliver on the branch the Deliver phase names.`,
        `- Keep the diff tight; no drive-by refactors.`,
      ],
    }),
  ]
    .filter(Boolean)
    .join("\n")
}

export default {
  name: "Agentproto Agent Verb",
  id: "agentproto-agent-verb",
  description:
    "Parameterized sandboxed agentflow verb: `pr` implements a request/issue and opens a PR; `fix` applies the latest review's changes (fixDelivery: pr|commit). Shares the sandbox machinery with the pr-review workflow.",
  version: "0.1.0",
  inputs: {
    verb: { type: "string", description: "Agent verb: pr | fix (implement = alias of pr)." },
    prNumber: { type: "number", description: "PR number (fix; or pr triggered from a PR comment).", default: 0 },
    issueNumber: { type: "number", description: "Issue number (pr/implement on an issue).", default: 0 },
    requestText: { type: "string", description: "Free-text request for the pr verb.", default: "" },
    baseRef: { type: "string", description: "Base branch ref.", default: "main" },
    headRef: { type: "string", description: "PR head branch (fix verb).", default: "" },
    repo: { type: "string", description: "owner/repo slug — required for the sandbox bootstrap clone.", default: "" },
    githubToken: {
      type: "string",
      description:
        "Unused placeholder for parity with pr-review — the box receives GITHUB_TOKEN via the sandbox env passthrough, never via input.",
      default: "",
    },
    reviewConfig: { type: "object", description: "Parsed .github/agentic-review.json config.", default: {} },
  },
  outputs: {
    delivered: { type: "string", description: "pr | commit — how the change landed." },
    error: { type: "string", description: "Error message if the verb failed." },
  },
  steps: [
    {
      id: "work",
      kind: "agent",
      adapter: (b) => adapterFor(cfgOf(b), verbOf(b)),
      sandbox: (b) => sandboxRefFor(cfgOf(b), verbOf(b)),
      cwd: (b) => workspaceCwdFor(cfgOf(b), verbOf(b)),
      prompt: verbPrompt,
    },
  ],
}
