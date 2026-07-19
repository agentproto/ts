// Entry-based handle for the agentproto-run lane's PR review gate.
// Replaces the hand-rolled scripts/review-pr.mjs with an agentproto-driven
// claude-code session that posts reviews and writes changesets directly.

// Sandbox placement for the review step. `reviewerSandbox` in
// .github/agentic-review.json selects a sandbox provider slug (e.g. "e2b");
// absent/empty ⇒ host spawn (the pre-sandbox behavior). The inline spec's
// `env.passthrough` names the daemon-process env vars injected into the box —
// the box's own daemon + adapters resolve auth from that env (there is no
// ~/.agentproto/config.json inside a fresh box; claude-sdk reads
// ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from env — proven headless in a
// live e2b box).
//
// `installPackages` (e2b): the boot-time CLI update replaces the box's global
// npm install and LOSES the template-baked adapters (verified live), so the
// reviewer's adapter must be reinstalled in the same `npm i -g` — plus the
// Claude Code CLI itself when the adapter is claude-code.
const sandboxRef = (bindings) => {
  const cfg = bindings?.input?.reviewConfig || {}
  const slug = typeof cfg.reviewerSandbox === "string" ? cfg.reviewerSandbox.trim() : ""
  if (!slug) return undefined
  const adapter = String(cfg.reviewerAdapter || "claude-code")
  const passthrough = Array.isArray(cfg.reviewerSandboxEnv) && cfg.reviewerSandboxEnv.length > 0
    ? cfg.reviewerSandboxEnv
    : ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"]
  const installPackages = [
    `@agentproto/adapter-${adapter}@latest`,
    ...(adapter === "claude-code" ? ["@anthropic-ai/claude-code@latest"] : []),
  ]
  return { provider: slug, config: { installPackages }, env: { passthrough } }
}

const inSandbox = (bindings) => sandboxRef(bindings) !== undefined

// A sandbox box has no checkout — the agent must clone + fetch the PR before
// reviewing. GITHUB_TOKEN is injected into the box env (never inlined here).
const sandboxBootstrap = (prNumber, baseRef, repo) => [
  `## Phase 0: Workspace bootstrap (you are in a fresh sandbox — no checkout exists)`,
  ``,
  `1. Clone the repo using the GITHUB_TOKEN already exported in your environment (reference the env var — NEVER print its value):`,
  `   \`\`\`bash`,
  `   git clone "https://x-access-token:\${GITHUB_TOKEN}@github.com/${repo}.git" repo && cd repo`,
  `   git fetch origin ${baseRef} "pull/${prNumber}/head:pr-${prNumber}" && git checkout "pr-${prNumber}"`,
  `   \`\`\``,
  `2. Run all later git/file commands from this clone; the diff base is \`origin/${baseRef}\`.`,
  `3. If the \`gh\` CLI is not installed in this sandbox, post the review via the GitHub REST API instead:`,
  `   \`\`\`bash`,
  `   curl -sS -X POST -H "Authorization: Bearer \${GITHUB_TOKEN}" -H "Accept: application/vnd.github+json" \\`,
  `     "https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews" \\`,
  `     -d '{"event":"COMMENT","body":"<review markdown>"}'`,
  `   \`\`\``,
  `   (event: APPROVE / REQUEST_CHANGES / COMMENT.)`,
  `4. Changeset delivery from a sandbox: after writing \`.changeset/pr-${prNumber}-agentic.md\`, commit it and push to the PR head branch (\`git push origin HEAD:<head-branch>\`; find the head branch via \`gh pr view ${prNumber} --json headRefName\` or the REST API). If the push is rejected, include the changeset file content verbatim in the review body instead.`,
  ``,
].join("\n")

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

  return [
    `You are an expert code reviewer for the @agentproto/ts monorepo — a TypeScript implementation of open agent standards (AIPs).`,
    ``,
    `Your job: review PR #${prNumber} and post a structured GitHub review.`,
    ``,
    inSandbox(bindings) && repo ? sandboxBootstrap(prNumber, baseRef, repo) : "",
    `## Config (from .github/agentic-review.json)`,
    `- blocking: ${cfg.blocking} — the gate job will fail if you request changes.`,
    `- maxReviewTurns: ${cfg.maxReviewTurns} — this session should finish well within that.`,
    `- botMention: ${cfg.botMention} — sign off with this handle in the review footer.`,
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
    `   Run:`,
    `   \`\`\`bash`,
    `   gh pr review ${prNumber} --comment --body "<your review markdown>"`,
    `   \`\`\``,
    `   Replace --comment with --approve or --request-changes as appropriate.`,
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
    ``,
    `   ---`,
    `   ${cfg.botMention}`,
    `   \`\`\``,
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
    `   Bump rules:`,
    `   - patch: bug fix, internal refactor, test, docs, CI, dependency bump`,
    `   - minor: new exported function/type/class, new optional parameter, new feature`,
    `   - major: removed/renamed export, incompatible signature change, breaking behavior`,
    `   - CI / workflow / script changes → do NOT bump any package`,
    ``,
    `3. If you used --REQUEST-CHANGES, note that the \`pr-fix\` job will later read your review and attempt to apply fixes automatically.`,
    ``,
    `## Hard rules`,
    ``,
    `- NEVER add AI/Claude/Anthropic attribution (no \`Co-Authored-By: ...\`, no \`Generated with ...\`) to any output.`,
    `- The \`gh\` CLI is already authenticated via GITHUB_TOKEN in the environment.`,
    `- Keep exploration tight — posting the review is the most important action.`,
    `- If the PR is trivial (e.g. only CI changes, only docs), approve quickly with a brief comment.`,
    escalateGlobs.length > 0
      ? `- If the PR touches sensitive paths (migrations, auth, security, workflows, env files), be extra careful and request changes if anything looks off.`
      : "",
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
      adapter: (b) => String(b?.input?.reviewConfig?.reviewerAdapter || "claude-code"),
      // Sandbox placement (reviewerSandbox, e.g. "e2b"): the daemon-internal
      // spawn failure on the CI runner does not reproduce inside a sandbox —
      // the box's OWN daemon spawns the adapter (proven via agent_start
      // sandbox:"local", 5/6 adapters green). undefined ⇒ host spawn.
      sandbox: sandboxRef,
      // A remote box can't see the runner's checkout path — land in the box
      // workspace and let the Phase 0 bootstrap clone the repo there.
      cwd: (b) => (inSandbox(b) ? "/home/user" : undefined),
      prompt: reviewPrompt,
    },
  ],
}
