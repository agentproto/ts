#!/usr/bin/env node
/**
 * Agentic PR reviewer — analyze the diff, write an accurate changeset, post a
 * structured review (APPROVE / REQUEST_CHANGES / COMMENT).
 *
 * Thin entry over scripts/lib: the Anthropic loop, tools, config, and skills
 * are shared with apply-review.mjs and agent-command.mjs.
 *
 * Usage:
 *   node scripts/review-pr.mjs --pr 23            # review PR #23 and post
 *   node scripts/review-pr.mjs --pr 23 --dry-run  # analyze only, print
 *   node scripts/review-pr.mjs --dry-run          # review current branch vs main
 *
 * Env: ANTHROPIC_API_KEY (required), GITHUB_TOKEN (for posting), PR_NUMBER.
 */

import {
  loadConfig, resolveCommandConfig, loadSkills, renderSkillsBlock, runAgentLoop,
} from './lib/agent-core.mjs'
import { buildToolset } from './lib/tools.mjs'

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const prIdx = args.indexOf('--pr')
const PR_NUMBER = prIdx !== -1 ? args[prIdx + 1] : (process.env.PR_NUMBER ?? null)

if (!DRY_RUN && !PR_NUMBER) {
  console.error('Usage: review-pr.mjs [--pr <N>] [--dry-run]')
  process.exit(1)
}

const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) {
  console.error('Error: ANTHROPIC_API_KEY is not set.')
  process.exit(1)
}

const config = loadConfig()
const cmd = resolveCommandConfig(config, 'review')
const skills = loadSkills(cmd.skills ?? [], { allowExternal: cmd.externalSkills?.allow ?? [] })

const SYSTEM_PROMPT = `You are an expert code reviewer for the @agentproto/ts monorepo — a TypeScript implementation of open agent standards (AIPs).

You operate in two phases:

## Phase 1: Analyze
Call the available tools to understand the PR:
1. Start with \`git_log\` and \`git_diff\` to see what changed.
2. Call \`list_changed_packages\` to know the bump scope.
3. Use \`read_file\` and \`grep_repo\` to follow references, check call-sites, and understand context.
4. Form a clear picture of: correctness, type safety, AIP alignment, test coverage, and changeset accuracy.

## Phase 2: Act
When you have enough context, take these actions IN THIS ORDER. Keep Phase 1
exploration tight — posting the review is the single most important action, so
do it FIRST so it can never be lost if you run low on turns:

1. Call \`gh_pr_review\` (DO THIS FIRST — it is mandatory):
   - event: APPROVE if the PR looks correct and complete, REQUEST_CHANGES if something is wrong, COMMENT for observations only
   - body: a structured markdown review (see format below)

2. Call \`write_changeset\` with an accurate package list and bump levels:
   - patch: bug fix, internal refactor, test, docs, CI, dependency bump
   - minor: new exported function/type/class, new optional parameter, new feature (backward-compatible)
   - major: removed/renamed export, incompatible signature change, breaking behavior

3. Optionally call \`gh_pr_comment\` for supplementary inline observations.

You MUST call \`gh_pr_review\` exactly once before finishing. Never end without it.

## Review format

\`\`\`markdown
## Summary
[1-3 sentence overview of what this PR does]

## Changeset
[Table: package | bump | reason]

## Findings

### [Category: Correctness / Type Safety / Tests / AIP alignment / Nits]
- [finding]

## Verdict
[LGTM ✅ / Changes needed ❌ / Observations 💬] — [one-sentence rationale]
\`\`\`

## Bump rules
- Changing a type that callers depend on → minor or major depending on breaking-ness
- Fixing a bug that was already exported behavior → patch
- Adding a new MCP tool verb → minor (new public surface)
- Adding a new exported function to an AIP package → minor
- CI / workflow / script changes → do NOT bump any package (omit from changeset)

## Changeset accuracy
After calling \`list_changed_packages\`, verify each package is correctly accounted for.
If the diff shows a \`scripts/**\` or \`.github/**\` change but no package export changed, do NOT add a changeset entry for it.${renderSkillsBlock(skills)}`

const { defs, impls } = buildToolset(
  ['@read', '@review', 'list_changed_packages'],
  { prNumber: PR_NUMBER, dryRun: DRY_RUN, baseRef: 'origin/main' }
)

const userPrompt = PR_NUMBER
  ? `Please review PR #${PR_NUMBER} on the @agentproto/ts monorepo. Call git_log and git_diff (and a few targeted reads) to understand the change, then POST your review with gh_pr_review FIRST, and write the changeset after. Keep exploration efficient.`
  : `Please review the current branch (vs origin/main) of the @agentproto/ts monorepo. Call git_log and git_diff, post your review first, then write the changeset (dry-run mode: print to stdout instead of posting).`

console.log(`\n🔍 PR Reviewer starting${DRY_RUN ? ' (dry-run)' : ''}…  model=${cmd.model}  skills=[${skills.map((s) => s.name).join(', ')}]`)
if (PR_NUMBER) console.log(`   PR: #${PR_NUMBER}`)

const result = await runAgentLoop({
  apiKey,
  model: cmd.model,
  system: SYSTEM_PROMPT,
  tools: defs,
  toolImpls: impls,
  userPrompt,
  maxTokens: 4096,
  maxTurns: 30,
  onTurn: (t) => console.log(`\n⟳  Turn ${t}`),
  onToolCall: (name, input) => console.log(`   🔧 ${name}(${Object.keys(input).join(', ')})`),
})

if (result.finalText) console.log('\n' + result.finalText)
if (result.maxedOut) console.warn('\n⚠️  Reached max iterations — stopping.')

// Guard: the review MUST be posted. Scan the transcript for the gh_pr_review
// tool call. If it never happened (e.g. the agent ran out of turns mid-explore,
// as on #72), fail loudly instead of letting the gate post a false green.
const postedReview = result.messages.some(
  (m) =>
    Array.isArray(m.content) &&
    m.content.some((b) => b.type === 'tool_use' && b.name === 'gh_pr_review'),
)
console.log('\n✅ Review complete.')
if (!postedReview && !DRY_RUN) {
  console.error(
    '\n❌ Reviewer finished WITHOUT calling gh_pr_review — no review was posted. ' +
      'Failing so the gate does not report a false success.',
  )
  process.exit(2)
}
