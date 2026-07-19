// Entry-based handle for the agentproto-run lane's PR review gate.
// Replaces the hand-rolled scripts/review-pr.mjs with an agentproto-driven
// claude-code session that posts reviews and writes changesets directly.
//
// The command-AGNOSTIC sandbox machinery (placement spec, Phase-0 bootstrap,
// gh-free REST delivery recipes, hard rules) is factored into
// `../lib/sandbox-agent.mjs`, shared with the `agent-verb` workflow (/pr,
// /fix) — this entry only owns the REVIEW prompt and its delivery choice.

import {
  adapterFor,
  bootstrapBlock,
  changesetRulesBlock,
  hardRulesBlock,
  restPostReviewBlock,
  sandboxRefFor,
  workspaceCwdFor,
} from "../lib/sandbox-agent.mjs"

const sandboxRef = (bindings) => sandboxRefFor(bindings?.input?.reviewConfig, "review")

const inSandbox = (bindings) => sandboxRef(bindings) !== undefined

// How to post the review — the ONE Phase-2 posting instruction, switched on
// placement so the sandbox path never references the absent `gh` CLI.
const postReviewInstruction = (sandboxed, prNumber, repo) =>
  sandboxed
    ? restPostReviewBlock({ repo, prNumber })
    : [
        `   Run:`,
        `   \`\`\`bash`,
        `   gh pr review ${prNumber} --comment --body "<your review markdown>"`,
        `   \`\`\``,
        `   Replace --comment with --approve or --request-changes as appropriate.`,
      ].join("\n")

// Changeset delivery, switched on placement: the host lane's checkout is the
// CI workspace (the job commits it); a sandbox clone is ephemeral, so the
// changeset must be pushed to the PR head branch — head branch resolved via
// REST (no `gh` in the box).
const changesetDeliveryInstruction = (sandboxed, prNumber, repo) =>
  sandboxed
    ? [
        `   Sandbox delivery: commit the changeset file and push it to the PR head branch:`,
        `   \`\`\`bash`,
        `   HEAD_BRANCH=$(curl -sS -H "Authorization: Bearer \${GITHUB_TOKEN}" -H "Accept: application/vnd.github+json" \\`,
        `     "https://api.github.com/repos/${repo}/pulls/${prNumber}" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).head.ref))')`,
        `   git add .changeset/pr-${prNumber}-agentic.md && git commit -m "chore: agentic reviewer — changeset" && git push origin "HEAD:\${HEAD_BRANCH}"`,
        `   \`\`\``,
        `   If the push is rejected, include the changeset file content verbatim in a follow-up PR comment (POST /repos/${repo}/issues/${prNumber}/comments with a {"body": ...} payload) instead — never fail the review over changeset delivery.`,
      ].join("\n")
    : ""

const reviewPrompt = (bindings) => {
  const { prNumber, baseRef = "main", repo = "", reviewConfig = {} } = bindings.input
  const cfg = {
    blocking: true,
    botMention: "@agentproto-bot",
    maxReviewTurns: 50,
    merge: { alwaysEscalateGlobs: [] },
    ...reviewConfig,
  }

  const escalateGlobs = cfg.merge?.alwaysEscalateGlobs || []
  const escalateNote =
    escalateGlobs.length > 0
      ? `If the PR touches any of these paths, be extra careful and flag risks explicitly, but review normally — merge-time escalation handles final approval: ${escalateGlobs.join(", ")}`
      : ""

  const sandboxed = inSandbox(bindings) && Boolean(repo)

  return [
    `You are an expert code reviewer for the @agentproto/ts monorepo — a TypeScript implementation of open agent standards (AIPs).`,
    ``,
    `Your job: review PR #${prNumber} and post a structured GitHub review.`,
    ``,
    sandboxed ? bootstrapBlock({ repo, baseRef, prNumber }) : "",
    `## Config (from .github/agentic-review.json)`,
    `- blocking: ${cfg.blocking} — the gate job will fail if you request changes.`,
    `- maxReviewTurns: ${cfg.maxReviewTurns} — this session should finish well within that.`,
    `- botMention: ${cfg.botMention} — the runner stamps this as a provenance footer; do not add it yourself.`,
    escalateNote,
    ``,
    `## Phase 1: Analyze`,
    ``,
    `1. Run \`git diff origin/${baseRef}...HEAD\` to see what changed.`,
    `2. Use read_file and search (grep / rg) to follow references, check call-sites, and understand context.`,
    `3. Identify: correctness issues, type safety, AIP alignment, test coverage, and whether a changeset is needed.`,
    ``,
    `## Phase 2: Act (in this order)`,
    ``,
    `1. **POST THE REVIEW FIRST** (mandatory — do this before anything else):`,
    postReviewInstruction(sandboxed, prNumber, repo),
    `   The review body must follow this format:`,
    ``,
    `   \`\`\`markdown`,
    `   ## Summary`,
    `   [1-3 sentence overview]`,
    ``,
    `   ## Changeset`,
    `   [Table: package | bump | reason]`,
    ``,
    `   ## Findings`,
    `   ### [Category]`,
    `   - [finding with file:line]`,
    ``,
    `   ## Verdict`,
    `   [LGTM ✅ / Changes needed ❌ / Observations 💬] — [rationale]`,
    `   \`\`\``,
    ``,
    `   Do NOT add a signature or footer — the CI runner stamps a deterministic`,
    `   \`${cfg.botMention}\` provenance footer (session id, cost, run) onto your`,
    `   posted review automatically. Just write the review body above.`,
    ``,
    `2. **Write a changeset** if the PR touches published packages:`,
    `   Run \`node scripts/list-changed-packages.mjs\` (or inspect the diff) to find changed packages.`,
    `   Then write a changeset file to \`.changeset/pr-${prNumber}-agentic.md\` with the format:`,
    ``,
    `   \`\`\`yaml`,
    `   ---`,
    `   "package-name": patch`,
    `   ---`,
    ``,
    `   Description of the change.`,
    `   \`\`\``,
    ``,
    changesetRulesBlock(),
    ``,
    changesetDeliveryInstruction(sandboxed, prNumber, repo),
    `3. If you requested changes (REQUEST_CHANGES), note that the \`pr-fix\` job will later read your review and attempt to apply fixes automatically.`,
    ``,
    hardRulesBlock({
      sandboxed,
      extra: [
        `- Keep exploration tight — posting the review is the most important action.`,
        `- If the PR is trivial (e.g. only CI changes, only docs), approve quickly with a brief comment.`,
        ...(escalateGlobs.length > 0
          ? [
              `- If the PR touches sensitive paths (migrations, auth, security, workflows, env files), be extra careful and request changes if anything looks off.`,
            ]
          : []),
      ],
    }),
  ]
    .filter(Boolean)
    .join("\n")
}

export default {
  name: "Agentproto PR Review",
  id: "agentproto-pr-review",
  description:
    "Agentic PR reviewer that reads the diff, writes an accurate changeset, and posts a structured review (APPROVE / REQUEST_CHANGES / COMMENT). Driven by claude-code over the agentproto daemon.",
  version: "0.1.0",
  inputs: {
    prNumber: { type: "number", description: "The pull request number to review." },
    baseRef: { type: "string", description: "Base branch ref.", default: "main" },
    repo: { type: "string", description: "owner/repo slug — required for the sandbox bootstrap clone.", default: "" },
    githubToken: { type: "string", description: "GitHub token for posting reviews." },
    anthropicApiKey: { type: "string", description: "Fallback API key (not used by this workflow, but passed for compatibility)." },
    reviewConfig: { type: "object", description: "Parsed .github/agentic-review.json config.", default: {} },
  },
  outputs: {
    conclusion: { type: "string", description: "approved | changes_requested | comment" },
    reviewBody: { type: "string", description: "The markdown review body posted." },
    changesetWritten: { type: "boolean", description: "Whether a changeset was written." },
    error: { type: "string", description: "Error message if the review failed." },
  },
  steps: [
    {
      id: "review",
      kind: "agent",
      // Adapter is configurable via .github/agentic-review.json
      // (reviewerAdapter). Defaults to claude-code but that adapter drives the
      // Claude Code CLI, which no-ops headless in CI ("Authentication
      // required" / empty turn) — claude-sdk (SDK-based) authenticates headless.
      adapter: (b) => adapterFor(b?.input?.reviewConfig, "review"),
      // Sandbox placement (reviewerSandbox, e.g. "e2b"): the daemon-internal
      // spawn failure on the CI runner does not reproduce inside a sandbox —
      // the box's OWN daemon spawns the adapter (proven via agent_start
      // sandbox:"local", 5/6 adapters green). undefined ⇒ host spawn.
      sandbox: sandboxRef,
      // A remote box can't see the runner's checkout path — land in the box
      // workspace and let the Phase 0 bootstrap clone the repo there.
      cwd: (b) => workspaceCwdFor(b?.input?.reviewConfig, "review"),
      prompt: reviewPrompt,
    },
  ],
}
