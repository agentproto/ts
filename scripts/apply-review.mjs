#!/usr/bin/env node
/**
 * Agentic review fixer — reads the latest CHANGES_REQUESTED review and applies
 * the requested changes.
 *
 * Delivery (config.fixDelivery, overridable via --delivery):
 *   "commit" — write to the working tree; the caller (CI) commits + pushes to
 *              the PR branch. Exit 0 with a dirty tree.
 *   "pr"     — write to the working tree, then open a stacked PR (bot/fix-<pr>
 *              → the PR's head branch) via gh_open_pr from inside the agent.
 *
 * Thin entry over scripts/lib (shared loop, tools, config, skills).
 *
 * Usage: node scripts/apply-review.mjs [--delivery commit|pr]
 * Env: ANTHROPIC_API_KEY, GITHUB_TOKEN, PR_NUMBER (all required).
 *
 * Exit codes:
 *   0 — changes applied (commit mode) / PR opened (pr mode) / loop exhausted
 *   1 — unexpected error
 */

import { execFileSync } from 'node:child_process'
import {
  loadConfig, resolveCommandConfig, loadSkills, renderSkillsBlock, runAgentLoop, run, ROOT,
} from './lib/agent-core.mjs'
import { buildToolset } from './lib/tools.mjs'

const args = process.argv.slice(2)
const delIdx = args.indexOf('--delivery')
const PR_NUMBER = process.env.PR_NUMBER
const apiKey = process.env.ANTHROPIC_API_KEY

if (!PR_NUMBER) { console.error('Error: PR_NUMBER env var is required.'); process.exit(1) }
if (!apiKey) { console.error('Error: ANTHROPIC_API_KEY env var is required.'); process.exit(1) }

const config = loadConfig()
const cmd = resolveCommandConfig(config, 'fix')
const DELIVERY = delIdx !== -1 ? args[delIdx + 1] : (cmd.fixDelivery ?? 'commit')
const MAX_ITER = cmd.maxFixIterations ?? 3
const FIX_COMMIT_MARKER = 'auto-fix from review'

const skills = loadSkills(cmd.skills ?? [], { allowExternal: cmd.externalSkills?.allow ?? [] })

// ── iteration accounting (commit mode loops via CI; pr mode is one-shot) ──────

function countPastIterations() {
  try {
    const { commits } = JSON.parse(
      execFileSync('gh', ['pr', 'view', PR_NUMBER, '--json', 'commits'],
        { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
    )
    return (commits ?? []).filter((c) => c.messageHeadline.includes(FIX_COMMIT_MARKER)).length
  } catch {
    const log = run(`git log --oneline --grep="${FIX_COMMIT_MARKER}" origin/main..HEAD`)
    return log ? log.split('\n').filter(Boolean).length : 0
  }
}

function postEscalation() {
  try {
    execFileSync('gh', ['pr', 'comment', PR_NUMBER, '--body',
      `⚠️ **Auto-fix loop exhausted** after ${MAX_ITER} iterations without approval.\n\n` +
      `The agentic fixer has applied ${MAX_ITER} rounds of changes but the reviewer still ` +
      `requests more changes. A human must now address the remaining comments manually.\n\n` +
      `**To force-merge** (admins only):\n\`\`\`\ngh pr merge --admin ${PR_NUMBER}\n\`\`\``,
    ], { cwd: ROOT, encoding: 'utf8' })
  } catch {}
}

// ── system prompt (delivery-aware) ───────────────────────────────────────────

const deliveryInstruction = DELIVERY === 'pr'
  ? `5. When all changes are written, call \`gh_open_pr\` to deliver them as a stacked PR:
   - branch: "bot/fix-${PR_NUMBER}"
   - base: the PR's head branch (read it from gh_get_pr → headRefName)
   - title: "fix: address review on #${PR_NUMBER}"
   - body: a short bullet list of what you changed and why, referencing the review.
   Do NOT commit to the PR branch directly in this mode.`
  : `5. Stop. Do NOT post a review comment and do NOT open a PR — the CI job commits and pushes your working-tree changes to the PR branch.`

const SYSTEM_PROMPT = `You are an agentic fixer for the @agentproto/ts monorepo.
Your job is to address EVERY change requested in the latest PR review and write the fixed files.

## Workflow — follow this order exactly

1. Call \`git_diff\` to understand what the PR changes.
2. Call \`get_review\` to read the CHANGES_REQUESTED review body and all inline comments.
3. For each file mentioned, call \`read_file\` to see its current content.
4. Call \`write_file\` for each file that needs changes, providing the COMPLETE corrected content.
   - Never truncate — always write the full file.
   - Address every comment. If ambiguous, make the minimal change that satisfies the intent.
   - Do not make unrelated changes.
   - Optionally call \`run_command\` (pnpm build / check-types / test) to verify your fix compiles before finishing.
${deliveryInstruction}

## Constraints
- Only modify files mentioned in the review, or files that must change to satisfy a comment.
- Written files must be syntactically valid TypeScript / JavaScript / YAML / Markdown.${renderSkillsBlock(skills)}`

// ── tool surface (pr mode adds gh_open_pr + gh_get_pr) ───────────────────────

const toolNames = DELIVERY === 'pr'
  ? ['@fix', 'read_file', 'grep_repo', 'gh_get_pr', 'gh_open_pr']
  : ['@fix', 'read_file', 'grep_repo']

const { defs, impls } = buildToolset(toolNames, { prNumber: PR_NUMBER, dryRun: false, baseRef: 'origin/main' })

// ── main ─────────────────────────────────────────────────────────────────────

console.log(`\n🔧 Review fixer starting — PR #${PR_NUMBER}  delivery=${DELIVERY}  model=${cmd.model}`)

const pastIter = countPastIterations()
console.log(`   Fix iterations already on branch: ${pastIter}`)

if (DELIVERY === 'commit' && pastIter >= MAX_ITER) {
  console.log(`\n⚠️  Loop exhausted (${MAX_ITER} iterations) — escalating to human.`)
  postEscalation()
  process.exit(0)
}

const result = await runAgentLoop({
  apiKey,
  model: cmd.model,
  system: SYSTEM_PROMPT,
  tools: defs,
  toolImpls: impls,
  userPrompt:
    `Please fix all review comments on PR #${PR_NUMBER}. ` +
    `This is fix iteration ${pastIter + 1} of ${MAX_ITER} max. Delivery mode: ${DELIVERY}. ` +
    `Start with git_diff and get_review, read each relevant file, then apply all requested changes with write_file` +
    (DELIVERY === 'pr' ? ', and finally open a stacked PR with gh_open_pr.' : '.'),
  maxTokens: 8192,
  maxTurns: 20,
  onTurn: (t) => console.log(`\n⟳  Turn ${t}`),
  onToolCall: (name, input) => console.log(`   🔧 ${name}(${Object.keys(input).join(', ')})`),
})

if (result.finalText) console.log('\n' + result.finalText)
if (result.maxedOut) console.warn('\n⚠️  Reached max agentic turns — stopping.')
console.log(`\n✅ Fixer complete (delivery=${DELIVERY}).` +
  (DELIVERY === 'commit' ? ' CI will commit and push.' : ' Stacked PR opened by the agent.'))
