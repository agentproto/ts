#!/usr/bin/env node
/**
 * Agentic issue triage — runs when an issue is opened/reopened (or on demand
 * via /triage). The agent reads the issue, posts a concise triage comment
 * (summary · type · is it actionable · suggested next step), and applies labels
 * from the repo's existing label set.
 *
 * Thin entry over scripts/lib (shared loop, tools, config, skills).
 *
 * Env: ANTHROPIC_API_KEY, GITHUB_TOKEN, ISSUE_NUMBER (all required).
 */

import {
  loadConfig, resolveCommandConfig, loadSkills, renderSkillsBlock, runAgentLoop,
} from './lib/agent-core.mjs'
import { buildToolset } from './lib/tools.mjs'

const apiKey = process.env.ANTHROPIC_API_KEY
const ISSUE_NUMBER = process.env.ISSUE_NUMBER

if (!apiKey) { console.error('Error: ANTHROPIC_API_KEY is required.'); process.exit(1) }
if (!ISSUE_NUMBER) { console.error('Error: ISSUE_NUMBER is required.'); process.exit(1) }

const config = loadConfig()
const cmd = resolveCommandConfig(config, 'triage')
const skills = loadSkills(cmd.skills ?? [], { allowExternal: cmd.externalSkills?.allow ?? [] })

const SYSTEM_PROMPT = `You triage incoming issues for the @agentproto/ts monorepo — a TypeScript implementation of open agent standards (AIPs).

Workflow:
1. Call \`gh_get_issue\` (number ${ISSUE_NUMBER}) to read the issue body, author, and any comments.
2. Call \`gh_list_labels\` to see which labels exist. Apply ONLY labels from that list.
3. Optionally use the read tools (\`grep_repo\`, \`read_file\`) to confirm whether the report is valid / where it would land.
4. Call \`gh_label\` to apply the fitting labels (type + area). Do not invent labels.
5. Call \`gh_pr_comment\` (it targets the issue) with a SHORT triage note:

\`\`\`markdown
**Triage:** <one-line summary>
- **Type:** bug | feature | question | docs | chore
- **Area:** <package/area, or "unclear">
- **Actionable:** yes / needs-info (list what's missing) / no
- **Suggested next step:** <e.g. "ready to implement — comment \`/implement\` to have me open a PR", or a clarifying question>
\`\`\`

Be terse and useful. If the issue lacks repro/detail, say exactly what's missing instead of guessing.${renderSkillsBlock(skills)}`

const { defs, impls } = buildToolset(
  ['@triage', 'grep_repo', 'read_file'],
  { prNumber: ISSUE_NUMBER, dryRun: false, baseRef: 'origin/main' }
)

console.log(`\n🏷️  Issue triage starting — #${ISSUE_NUMBER}  model=${cmd.model}  skills=[${skills.map((s) => s.name).join(', ')}]`)

const result = await runAgentLoop({
  apiKey,
  model: cmd.model,
  system: SYSTEM_PROMPT,
  tools: defs,
  toolImpls: impls,
  userPrompt: `Triage issue #${ISSUE_NUMBER}: read it, apply fitting existing labels, and post the triage note.`,
  maxTokens: 2048,
  maxTurns: 14,
  onTurn: (t) => console.log(`\n⟳  Turn ${t}`),
  onToolCall: (name, input) => console.log(`   🔧 ${name}(${Object.keys(input).join(', ')})`),
})

if (result.finalText) console.log('\n' + result.finalText)
console.log('\n✅ Triage complete.')
