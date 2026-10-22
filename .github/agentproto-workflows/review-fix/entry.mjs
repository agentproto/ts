// Entry-based handle for the auto-fix lane.
//
// The auto-fix job used to drive `${ANTHROPIC_API_KEY}` through the
// hand-rolled scripts/apply-review.mjs loop (or Claude Code Cloud). This
// workflow replaces that with the same agentproto lane the reviewer uses:
// an OpenCode Go subscription session (opencode-go/deepseek-v4.1-flash,
// profile opencode-developerws003) spawned on the CI checkout.
//
// The session only writes the working tree. The calling job (`pr-fix` in
// ci.yml) stages, commits and pushes, exactly as it did before.

const fixPrompt = (bindings) => {
  const { prNumber, baseRef = "main", repo = "" } = bindings?.input ?? {}

  return [
    `You are a senior engineer for the @agentproto/ts monorepo.`,
    ``,
    `Your job: apply the latest CHANGES_REQUESTED review on PR #${prNumber} (repo ${repo || "this repository"}) to the current checkout.`,
    ``,
    `## Phase 1: Understand`,
    ``,
    `1. Read the PR and its reviews:`,
    `   \`gh pr view ${prNumber} --json title,body,headRefName,baseRefName,reviews\``,
    `   \`gh api --paginate "repos/${repo}/pulls/${prNumber}/reviews"\``,
    `   \`gh api --paginate "repos/${repo}/pulls/${prNumber}/comments"\``,
    `   Take the MOST RECENT review whose state is CHANGES_REQUESTED (or, absent one, the most recent COMMENTED review with actionable findings).`,
    `2. Read the diff for context: \`git diff origin/${baseRef}...HEAD\`. You are already on the PR head branch.`,
    `3. Read each file named by a finding before editing it. Never rewrite a file you have only partially read.`,
    ``,
    `## Phase 2: Apply the fixes`,
    ``,
    `1. Make the MINIMAL edits that resolve every actionable finding. Do not refactor beyond what the review asks, and do not make unrelated changes.`,
    `2. Prefer surgical replacements over whole-file rewrites.`,
    `3. Add or adjust tests where the review calls for coverage.`,
    `4. Verify what you changed where feasible (type-check or test the touched package; skip if installing dependencies would dominate the task).`,
    ``,
    `## Phase 3: Stop`,
    ``,
    `- Leave the changes in the working tree. Do NOT commit, do NOT push, do NOT open a PR, and do NOT post a review or comment.`,
    `- Do NOT run \`gh pr merge\` under any circumstances.`,
    `- Never add an AI-attribution trailer (no \`Co-Authored-By: ...\`, no \`Generated with ...\`, no equivalent) to any commit, PR body, or comment.`,
    `- Finish with a short bullet list of the files you changed and why.`,
  ].join("\n")
}

export default {
  name: "Agentproto Review Fix",
  id: "agentproto-review-fix",
  description:
    "Applies the latest CHANGES_REQUESTED review to the CI checkout on the OpenCode Go subscription. Writes the working tree only; the calling job commits and pushes.",
  version: "0.1.0",
  inputs: {
    prNumber: { type: "number", description: "Pull request number to fix.", default: 0 },
    baseRef: { type: "string", description: "Base branch ref.", default: "main" },
    repo: { type: "string", description: "owner/repo slug.", default: "" },
    githubToken: {
      type: "string",
      description: "Unused placeholder: gh reads GITHUB_TOKEN from the environment.",
      default: "",
    },
    reviewConfig: { type: "object", description: "Parsed .github/agentic-review.json.", default: {} },
  },
  outputs: {
    summary: { type: "string", description: "What the fixer changed." },
  },
  steps: [
    {
      id: "fix",
      kind: "agent",
      adapter: "opencode",
      prompt: fixPrompt,
    },
  ],
}
