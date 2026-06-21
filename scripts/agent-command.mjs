#!/usr/bin/env node
/**
 * On-demand command dispatcher — the entry the agent-command workflow runs when
 * someone slash-commands or @mentions the bot on a PR or issue.
 *
 * Triggers a verb, or interprets free-text after the bot mention:
 *
 *   /review                    review the PR (delegates to review-pr.mjs)
 *   /fix [--pr]                apply the latest review's changes (apply-review.mjs)
 *   /pr <request>              implement <request> on a new branch and open a PR
 *   /implement                 (on an issue) implement the issue and open a PR
 *   /explain <question>        answer a question about the diff/codebase as a comment
 *   /help                      post the command list
 *   @agentproto-bot <free text>  interpret and act (defaults to proposing a PR)
 *
 * Env (from the workflow):
 *   ANTHROPIC_API_KEY, GITHUB_TOKEN  — required
 *   COMMENT_BODY                     — the triggering comment
 *   PR_NUMBER / ISSUE_NUMBER         — whichever applies (one is set)
 *
 * Exit 0 always when it did something sensible; 1 only on hard error.
 */

import { execFileSync } from 'node:child_process'
import {
  loadConfig, resolveCommandConfig, loadSkills, renderSkillsBlock, runAgentLoop, ROOT,
} from './lib/agent-core.mjs'
import { buildToolset } from './lib/tools.mjs'

const apiKey = process.env.ANTHROPIC_API_KEY
const COMMENT_BODY = process.env.COMMENT_BODY ?? ''
const PR_NUMBER = process.env.PR_NUMBER || null
const ISSUE_NUMBER = process.env.ISSUE_NUMBER || null

if (!apiKey) { console.error('Error: ANTHROPIC_API_KEY is required.'); process.exit(1) }

const config = loadConfig()
const KNOWN_VERBS = ['review', 'fix', 'pr', 'implement', 'explain', 'help']

// ── parse the comment into { verb, args, freeText } ──────────────────────────

function parseCommand(body, botMention) {
  const trimmed = body.trim()

  // 1. Slash-command at the start of any line: /verb rest…
  for (const line of trimmed.split('\n')) {
    const m = line.trim().match(/^\/([a-z-]+)\b\s*(.*)$/i)
    if (m && KNOWN_VERBS.includes(m[1].toLowerCase())) {
      return { verb: m[1].toLowerCase(), args: m[2].trim(), freeText: m[2].trim(), via: 'slash' }
    }
  }

  // 2. @mention anywhere: strip it, interpret what follows.
  const mentionIdx = botMention ? trimmed.toLowerCase().indexOf(botMention.toLowerCase()) : -1
  if (mentionIdx !== -1) {
    const after = trimmed.slice(mentionIdx + botMention.length).trim()
    const first = after.split(/\s+/)[0]?.toLowerCase()
    if (KNOWN_VERBS.includes(first)) {
      const rest = after.slice(first.length).trim()
      return { verb: first, args: rest, freeText: rest, via: 'mention' }
    }
    // Free-text request — let the agent interpret it.
    return { verb: 'freeform', args: after, freeText: after, via: 'mention' }
  }

  return null
}

const parsed = parseCommand(COMMENT_BODY, config.botMention)
if (!parsed) {
  console.log('No bot command found in comment — nothing to do.')
  process.exit(0)
}

const flags = new Set(parsed.args.split(/\s+/).filter((t) => t.startsWith('--')))
const requestText = parsed.freeText.replace(/--\S+/g, '').trim()

console.log(`\n🤖 agent-command: verb=${parsed.verb} via=${parsed.via} pr=${PR_NUMBER ?? '-'} issue=${ISSUE_NUMBER ?? '-'}`)

// ── helpers ──────────────────────────────────────────────────────────────────

function execScript(script, scriptArgs) {
  execFileSync('node', [`scripts/${script}`, ...scriptArgs], {
    cwd: ROOT, stdio: 'inherit', env: process.env,
  })
}

function postComment(body) {
  const n = PR_NUMBER ?? ISSUE_NUMBER
  if (!n) return
  const sub = PR_NUMBER ? 'pr' : 'issue'
  try {
    execFileSync('gh', [sub, 'comment', String(n), '--body', body], { cwd: ROOT, encoding: 'utf8' })
  } catch (e) {
    console.warn(`could not post comment: ${e.message}`)
  }
}

async function runFlow({ command, system, toolNames, userPrompt, maxTokens = 8192 }) {
  const rc = resolveCommandConfig(config, command)
  const skills = loadSkills(rc.skills ?? [], { allowExternal: rc.externalSkills?.allow ?? [] })
  const { defs, impls } = buildToolset(toolNames, {
    prNumber: PR_NUMBER, dryRun: false, baseRef: 'origin/main',
  })
  console.log(`   model=${rc.model}  skills=[${skills.map((s) => s.name).join(', ')}]  tools=[${defs.map((d) => d.name).join(', ')}]`)
  const result = await runAgentLoop({
    apiKey,
    model: rc.model,
    system: system + renderSkillsBlock(skills),
    tools: defs,
    toolImpls: impls,
    userPrompt,
    maxTokens,
    maxTurns: 24,
    onTurn: (t) => console.log(`\n⟳  Turn ${t}`),
    onToolCall: (name, input) => console.log(`   🔧 ${name}(${Object.keys(input).join(', ')})`),
  })
  if (result.finalText) console.log('\n' + result.finalText)
  return result
}

// ── verb dispatch ─────────────────────────────────────────────────────────────

const HELP = `### 🤖 Agent commands

Comment any of these (slash-command, or \`${config.botMention} <verb> …\`):

| Command | What it does |
|---|---|
| \`/review\` | Re-review this PR and post a verdict + changeset |
| \`/fix\` | Apply the latest review's requested changes to this branch |
| \`/fix --pr\` | Apply them on a new \`bot/fix-<pr>\` branch and open a stacked PR |
| \`/pr <request>\` | Implement \`<request>\` on a new branch and open a PR |
| \`/implement\` | (on an issue) Implement the issue and open a PR |
| \`/explain <question>\` | Answer a question about the diff/codebase |
| \`/help\` | Show this list |

You can also just \`${config.botMention} <free-text request>\` and I'll interpret it.`

switch (parsed.verb) {
  case 'help': {
    postComment(HELP)
    break
  }

  case 'review': {
    if (!PR_NUMBER) { postComment('`/review` only works on a pull request.'); break }
    execScript('review-pr.mjs', ['--pr', PR_NUMBER])
    break
  }

  case 'fix': {
    if (!PR_NUMBER) { postComment('`/fix` only works on a pull request.'); break }
    const delivery = flags.has('--pr') ? 'pr' : (resolveCommandConfig(config, 'fix').fixDelivery ?? 'commit')
    execScript('apply-review.mjs', ['--delivery', delivery])
    if (delivery === 'commit') {
      // commit-mode writes the working tree; the workflow commits + pushes.
      console.log('fix (commit) — working tree updated; workflow will push.')
    }
    break
  }

  case 'pr':
  case 'implement': {
    const onIssue = !PR_NUMBER && ISSUE_NUMBER
    const targetDesc = onIssue
      ? `issue #${ISSUE_NUMBER}`
      : (requestText || 'the request in the triggering comment')
    await runFlow({
      command: 'pr',
      toolNames: ['@pr', '@read'],
      system: `You are a senior engineer for the @agentproto/ts monorepo. Implement the requested change end-to-end and deliver it as a pull request.

Workflow:
1. Understand context — ${onIssue ? `call \`gh_get_issue\` with number ${ISSUE_NUMBER} to read the full issue` : 'read the request below and the relevant code'}. Use \`read_file\`, \`grep_repo\`, \`git_diff\` to ground yourself.
2. Implement with \`write_file\` (complete files, no truncation). Add/adjust tests. Add a changeset if a published package changed (\`write_changeset\`).
3. Verify with \`run_command\` (pnpm build / check-types / test) where feasible.
4. Open the PR with \`gh_open_pr\`: branch \`bot/${onIssue ? `issue-${ISSUE_NUMBER}` : 'request'}\`, base \`main\`, a clear title and a body explaining the change${onIssue ? ` and closing #${ISSUE_NUMBER}` : ''}.

Only make changes required by the request. Keep the diff tight.`,
      userPrompt: `Implement ${targetDesc} and open a PR. ${onIssue ? '' : `Request: ${requestText}`}`,
    })
    break
  }

  case 'explain': {
    await runFlow({
      command: 'explain',
      toolNames: ['@read', 'gh_pr_comment', 'gh_get_issue'],
      maxTokens: 4096,
      system: `You answer questions about the @agentproto/ts monorepo for a developer reading a PR or issue. Investigate with the read tools (\`git_diff\`, \`read_file\`, \`grep_repo\`), then post ONE clear markdown answer with \`gh_pr_comment\`. Be concise and cite \`file:line\` where useful. Do not modify any files.`,
      userPrompt: `Question: ${requestText || COMMENT_BODY}\n\nInvestigate and post the answer as a comment on ${PR_NUMBER ? `PR #${PR_NUMBER}` : `issue #${ISSUE_NUMBER}`}.`,
    })
    break
  }

  case 'freeform':
  default: {
    // @mention with free text and no known verb — general developer agent.
    await runFlow({
      command: 'pr',
      toolNames: ['@pr', '@read', 'gh_pr_review'],
      system: `You are a senior engineer for the @agentproto/ts monorepo, responding to a free-text request on ${PR_NUMBER ? `PR #${PR_NUMBER}` : `issue #${ISSUE_NUMBER}`}.

Interpret the request and do what a developer would:
- A question → investigate and answer with \`gh_pr_comment\`.
- A code change → implement with \`write_file\`, verify with \`run_command\`, and deliver as a stacked PR with \`gh_open_pr\` (branch \`bot/request\`, base = this PR's head branch or \`main\`). Do not commit directly to a shared branch.
- Unclear → ask a brief clarifying question with \`gh_pr_comment\`.

Ground every action in the actual code via the read tools first.`,
      userPrompt: `Request from the comment:\n\n${requestText || COMMENT_BODY}`,
    })
    break
  }
}

console.log('\n✅ agent-command complete.')
