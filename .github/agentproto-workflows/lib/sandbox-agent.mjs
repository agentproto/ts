// Shared "sandboxed agentproto agent" block — the command-AGNOSTIC machinery
// every agentflow verb (review, pr, fix, …) composes on top of:
//
//   · sandbox placement (e2b spec: adapter install + auth env passthrough),
//   · the in-box workspace bootstrap (clone + optional PR fetch — a fresh box
//     has NO checkout and NO `gh` CLI, only git/node/npm/curl),
//   · gh-free GitHub delivery recipes (post review / open PR via curl REST),
//   · skill loading from the clone,
//   · the hard rules (no AI attribution, never echo tokens).
//
// Both `.github/agentproto-workflows/pr-review/entry.mjs` (verb: review) and
// `.github/agentproto-workflows/agent-verb/entry.mjs` (verbs: pr, fix)
// import from here, so the sandbox plumbing exists ONCE. The runner-side
// machinery (daemon boot, driver, observability, verify/fallback gating)
// lives in `.github/actions/agentproto-run/` + the calling workflows and is
// already verb-agnostic.
//
// Config source of truth: `.github/agentic-review.json`. Global keys set the
// lane (reviewerAdapter / reviewerSandbox / reviewerSandboxEnv); per-verb
// `commands.<verb>` overrides (skills, fixDelivery) are resolved with
// `resolveCommandConfig` — the same shallow-merge semantics as
// `scripts/lib/agent-core.mjs` (inlined here because this module runs inside
// the workflow-loader import, not the scripts toolchain).

/** `{...global, ...commands[verb]}` — per-verb keys win; `commands` removed. */
export const resolveCommandConfig = (config, verb) => {
  const base = { ...(config || {}) }
  delete base.commands
  return { ...base, ...(config?.commands?.[verb] ?? {}) }
}

/** Adapter slug for the lane (per-verb override allowed via commands.<verb>.reviewerAdapter). */
export const adapterFor = (config, verb) =>
  String(resolveCommandConfig(config, verb).reviewerAdapter || "claude-code")

/**
 * Provision-time setup command (e2b `setupCommands`) that installs a git
 * `commit-msg` hook STRIPPING AI-attribution trailer lines, so a sandboxed
 * model's native-shell commits can't deadlock the PR against the repo's own
 * Hygiene check (issue #589). Deterministic and hook-based — NOT a prompt rule
 * the agent can ignore.
 *
 * Installed via `core.hooksPath` (global), not `.git/hooks/`, because at
 * provision time the box has NO checkout yet — the clone happens later in
 * Phase 0. A global hooks path applies to that future clone too.
 *
 * CAVEAT — this global hook is not sufficient on its own. This repo's `prepare`
 * script runs husky, which points a LOCAL `core.hooksPath` at `.husky/_`, and a
 * local hooksPath SHADOWS the global one. So the moment the box runs
 * `pnpm install` (e.g. to validate a change), this strip hook stops firing and a
 * model's `Co-Authored-By: Claude …` trailer survives — which deadlocked PR #676
 * against Hygiene. The durable backstop is the committed `.husky/commit-msg` hook
 * (same strip logic), which husky's own `_/commit-msg` wrapper execs, so coverage
 * holds under whichever hooksPath wins. Keep both: this one covers a box that
 * never installs; `.husky/commit-msg` covers one that does.
 *
 * Idempotent: the command only (re)writes the same hook file and (re)sets the
 * same config key, so re-running it never double-installs or corrupts.
 *
 * The stripped pattern mirrors `ATTRIBUTION_PATTERN` in `.github/workflows/
 * ci.yml` (case-insensitively: `Co-authored-by:.*@anthropic.com`,
 * `Co-authored-by:.*claude.ai`, `Generated with`). `grep -iv || true` keeps
 * the hook succeeding even if it filters every line.
 */
export const ATTRIBUTION_STRIP_SETUP_COMMAND = [
  `mkdir -p "$HOME/.agentproto-git-hooks"`,
  `cat > "$HOME/.agentproto-git-hooks/commit-msg" <<'HOOK'`,
  `#!/bin/sh`,
  `# Strip AI-attribution trailers so commits pass the repo Hygiene check (#589).`,
  `grep -ivE 'Co-authored-by:.*@anthropic\\.com|Co-authored-by:.*claude\\.ai|Generated with' "$1" > "$1.agentproto.tmp" || true`,
  `mv "$1.agentproto.tmp" "$1"`,
  `HOOK`,
  `chmod +x "$HOME/.agentproto-git-hooks/commit-msg"`,
  `git config --global core.hooksPath "$HOME/.agentproto-git-hooks"`,
].join("\n")

/**
 * Sandbox placement: `reviewerSandbox` selects a provider slug (e.g. "e2b");
 * absent/empty ⇒ host spawn. The inline spec's `env.passthrough` names the
 * daemon-process env vars injected into the box — the box's own daemon +
 * adapters resolve auth from that env (there is no ~/.agentproto/config.json
 * inside a fresh box; claude-sdk reads ANTHROPIC_API_KEY /
 * ANTHROPIC_AUTH_TOKEN from env — proven headless in a live e2b box).
 *
 * `installPackages` (e2b): the boot-time CLI update replaces the box's global
 * npm install and LOSES the template-baked adapters (verified live), so the
 * verb's adapter must be reinstalled in the same `npm i -g` — plus the
 * Claude Code CLI itself when the adapter is claude-code.
 */
export const sandboxRefFor = (config, verb) => {
  const cfg = resolveCommandConfig(config, verb)
  const slug = typeof cfg.reviewerSandbox === "string" ? cfg.reviewerSandbox.trim() : ""
  if (!slug) return undefined
  const adapter = adapterFor(config, verb)
  const passthrough = Array.isArray(cfg.reviewerSandboxEnv) && cfg.reviewerSandboxEnv.length > 0
    ? cfg.reviewerSandboxEnv
    : ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"]
  const installPackages = [
    `@agentproto/adapter-${adapter}@latest`,
    ...(adapter === "claude-code" ? ["@anthropic-ai/claude-code@latest"] : []),
  ]
  // Pin the boot CLI install to a known-good version so a broken
  // `@agentproto/cli@latest` publish can't silently kill the box. Only pass
  // the key when configured — the provider defaults to `@latest` otherwise.
  const cliVersion = typeof cfg.cliVersion === "string" ? cfg.cliVersion.trim() : ""
  // Provision-time commit-msg hook that strips AI-attribution trailers, so a
  // sandboxed model's native commits can't deadlock the PR against Hygiene (#589).
  const sandboxConfig = {
    installPackages,
    setupCommands: [ATTRIBUTION_STRIP_SETUP_COMMAND],
    ...(cliVersion ? { cliVersion } : {}),
  }
  return { provider: slug, config: sandboxConfig, env: { passthrough } }
}

/** In-box working directory when sandboxed (the box workspace); undefined ⇒ run cwd. */
export const workspaceCwdFor = (config, verb) =>
  sandboxRefFor(config, verb) !== undefined ? "/home/user" : undefined

/**
 * Phase-0 workspace bootstrap for a fresh box: clone via the injected
 * GITHUB_TOKEN, optionally fetch a PR head. States up front that there is NO
 * `gh` CLI so the model never reaches for it.
 */
export const bootstrapBlock = ({ repo, baseRef = "main", prNumber }) => [
  `## Phase 0: Workspace bootstrap (you are in a fresh sandbox — no checkout exists)`,
  ``,
  `This sandbox has git, node, npm, and curl — there is NO \`gh\` CLI. Do not try to use \`gh\`; all GitHub API interactions use curl with the GITHUB_TOKEN env var (reference the env var — NEVER print its value).`,
  ``,
  `1. Clone the repo:`,
  `   \`\`\`bash`,
  `   git clone "https://x-access-token:\${GITHUB_TOKEN}@github.com/${repo}.git" repo && cd repo`,
  ...(prNumber
    ? [`   git fetch origin ${baseRef} "pull/${prNumber}/head:pr-${prNumber}" && git checkout "pr-${prNumber}"`]
    : [`   git checkout ${baseRef}`]),
  `   \`\`\``,
  `2. Run all later git/file commands from this clone${prNumber ? `; the diff base is \`origin/${baseRef}\`` : ""}.`,
  ``,
].join("\n")

/**
 * Skills, loaded FROM THE CLONE: the box can't run the runner-side skill
 * loader, but the repo it just cloned carries `.github/agent-skills/*.md` —
 * instruct the model to read the verb's configured skills before acting.
 */
export const skillsBlock = (config, verb) => {
  const skills = resolveCommandConfig(config, verb).skills ?? []
  const inRepo = skills.filter((s) => typeof s === "string" && !s.includes("/"))
  if (inRepo.length === 0) return ""
  return [
    `## Skills (read these FIRST, from your clone)`,
    ``,
    ...inRepo.map((s) => `- Read \`.github/agent-skills/${s}.md\` and follow it.`),
    ``,
  ].join("\n")
}

/**
 * Post a PR review via the shared delivery helper (write body to a file first —
 * safe JSON quoting). The helper does the REST POST AND records the created
 * review to the artifact ledger, so the runner stamps the provenance footer by
 * id instead of re-discovering the review.
 */
export const restPostReviewBlock = ({ repo, prNumber }) => [
  `   Write the review body to a file first (safe JSON quoting), then deliver it via the shared helper (which POSTs to the GitHub REST API AND records the created review to the artifact ledger so CI can stamp its provenance footer):`,
  `   \`\`\`bash`,
  `   # review.md contains your review markdown`,
  `   node -e 'const fs=require("fs");fs.writeFileSync("payload.json",JSON.stringify({event:process.argv[1],body:fs.readFileSync("review.md","utf8")}))' COMMENT`,
  `   node .github/agentproto-workflows/lib/deliver-artifact.mjs \\`,
  `     --kind review --body-file payload.json \\`,
  `     --url "https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews"`,
  `   \`\`\``,
  `   Set the first node argument to APPROVE, REQUEST_CHANGES, or COMMENT as appropriate. The helper exits 0 and prints \`created review id=…\` on success; if it exits non-zero it prints the API response — read it and retry once.`,
].join("\n")

/**
 * Author changes on a branch and OPEN A PR via curl REST — the `pr`-delivery
 * recipe shared by /pr and /fix (fixDelivery: "pr"). gh-free by design.
 */
export const restOpenPrBlock = ({ repo, branch, base, titleHint }) => [
  `   Deliver as a NEW pull request (the box has no \`gh\` — pure git + curl REST):`,
  `   \`\`\`bash`,
  `   git config user.name "agentproto-bot" && git config user.email "agentproto-bot@users.noreply.github.com"`,
  `   git checkout -b "${branch}"`,
  `   git add -A && git commit -m "<concise conventional-commit title>"`,
  `   git push origin "HEAD:${branch}"`,
  `   node -e 'const fs=require("fs");fs.writeFileSync("pr.json",JSON.stringify({title:process.argv[1],head:"${branch}",base:"${base}",body:fs.readFileSync("pr-body.md","utf8")}))' "<PR title>"`,
  `   node .github/agentproto-workflows/lib/deliver-artifact.mjs \\`,
  `     --kind pr --body-file pr.json \\`,
  `     --url "https://api.github.com/repos/${repo}/pulls"`,
  `   \`\`\``,
  `   Write \`pr-body.md\` BEFORE running the helper: what changed, why, how it was verified${titleHint ? `, and reference ${titleHint}` : ""}. Do NOT add a signature or provenance footer — the CI runner stamps a deterministic \`@agentproto-bot\` footer (session id, cost, run link) onto the PR body it just recorded.`,
  `   The helper (\`.github/agentproto-workflows/lib/deliver-artifact.mjs\`) POSTs the PR AND records it to the artifact ledger so CI can stamp by id. It exits 0 and prints \`created pr id=… number=…\` on success; if it exits non-zero it prints the API response — read it and retry once.`,
].join("\n")

/** Commit-mode delivery: push the change directly onto an existing branch. */
export const commitDeliveryBlock = ({ branch }) => [
  `   Deliver by committing DIRECTLY to the existing branch \`${branch}\`:`,
  `   \`\`\`bash`,
  `   git config user.name "agentproto-bot" && git config user.email "agentproto-bot@users.noreply.github.com"`,
  `   git add -A && git commit -m "<concise conventional-commit title>"`,
  `   git push origin "HEAD:${branch}"`,
  `   \`\`\``,
].join("\n")

/** Changeset authoring rules (shared verbatim across verbs that touch code). */
export const changesetRulesBlock = () => [
  `   Bump rules:`,
  `   - patch: bug fix, internal refactor, test, docs, CI, dependency bump`,
  `   - minor: new exported function/type/class, new optional parameter, new feature`,
  `   - major: removed/renamed export, incompatible signature change, breaking behavior`,
  `   - CI / workflow / script changes → do NOT bump any package`,
].join("\n")

/** The non-negotiables, placement-aware. */
export const hardRulesBlock = ({ sandboxed, extra = [] }) => [
  `## Hard rules`,
  ``,
  `- NEVER add AI/Claude/Anthropic attribution (no \`Co-Authored-By: ...\`, no \`Generated with ...\`) to any output, commit, or PR body.`,
  sandboxed
    ? `- There is NO \`gh\` CLI here — use curl against api.github.com with the GITHUB_TOKEN env var for every GitHub API call, and never echo the token.`
    : `- The \`gh\` CLI is already authenticated via GITHUB_TOKEN in the environment.`,
  ...extra,
].join("\n")
