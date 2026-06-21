#!/usr/bin/env node
/**
 * Agentic discussion responder.
 *
 *   EVENT=discussion           → a new discussion was opened: answer/triage it.
 *   EVENT=discussion_comment   → a comment was added: act only if it slash-
 *                                commands or @mentions the bot.
 *
 * Discussions are GraphQL-only; the bot needs the GitHub App permission
 * "Discussions: Read & write".
 *
 * Env: ANTHROPIC_API_KEY, GH_TOKEN/GITHUB_TOKEN, GITHUB_REPOSITORY,
 *      DISCUSSION_NUMBER, DISCUSSION_NODE_ID, EVENT, COMMENT_BODY (comment only).
 */

import {
  loadConfig, resolveCommandConfig, loadSkills, renderSkillsBlock, runAgentLoop,
} from './lib/agent-core.mjs'
import { buildToolset } from './lib/tools.mjs'

const apiKey = process.env.ANTHROPIC_API_KEY
const EVENT = process.env.EVENT ?? 'discussion'
const DISCUSSION_NUMBER = process.env.DISCUSSION_NUMBER
const DISCUSSION_NODE_ID = process.env.DISCUSSION_NODE_ID
const COMMENT_BODY = process.env.COMMENT_BODY ?? ''

if (!apiKey) { console.error('Error: ANTHROPIC_API_KEY is required.'); process.exit(1) }
if (!DISCUSSION_NUMBER || !DISCUSSION_NODE_ID) {
  console.error('Error: DISCUSSION_NUMBER and DISCUSSION_NODE_ID are required.'); process.exit(1)
}

const config = loadConfig()
const cmd = resolveCommandConfig(config, 'discussion')

// On a comment event, only act on an explicit command or mention.
if (EVENT === 'discussion_comment') {
  const body = COMMENT_BODY.trim()
  const mentioned = config.botMention && body.toLowerCase().includes(config.botMention.toLowerCase())
  const slashed = /^\/(answer|explain|help)\b/im.test(body)
  if (!mentioned && !slashed) {
    console.log('Discussion comment has no bot command — nothing to do.')
    process.exit(0)
  }
}

const skills = loadSkills(cmd.skills ?? [], { allowExternal: cmd.externalSkills?.allow ?? [] })

const SYSTEM_PROMPT = `You answer GitHub Discussions for the @agentproto/ts monorepo — a TypeScript implementation of open agent standards (AIPs).

Workflow:
1. Call \`gh_get_discussion\` (number ${DISCUSSION_NUMBER}) to read the question, category, and existing comments.
2. Ground your answer in the actual code with the read tools (\`grep_repo\`, \`read_file\`, \`git_log\`). Do not speculate — if the repo doesn't support a claim, say so.
3. Post ONE helpful markdown answer with \`gh_discussion_comment\`. Cite \`file:line\` where useful. If it's a feature idea, summarize it and suggest opening an issue (\`/implement\`-ready).

Be concise and accurate. If the question is unclear, ask one focused clarifying question instead of guessing.${renderSkillsBlock(skills)}`

const { defs, impls } = buildToolset(
  ['@discussion', 'grep_repo', 'read_file', 'git_log'],
  { discussionNumber: DISCUSSION_NUMBER, discussionNodeId: DISCUSSION_NODE_ID, dryRun: false }
)

console.log(`\n💬 Discussion responder — #${DISCUSSION_NUMBER} (${EVENT})  model=${cmd.model}  skills=[${skills.map((s) => s.name).join(', ')}]`)

const result = await runAgentLoop({
  apiKey,
  model: cmd.model,
  system: SYSTEM_PROMPT,
  tools: defs,
  toolImpls: impls,
  userPrompt: EVENT === 'discussion_comment'
    ? `A new comment was posted on discussion #${DISCUSSION_NUMBER}:\n\n${COMMENT_BODY}\n\nRead the full discussion and respond.`
    : `Answer discussion #${DISCUSSION_NUMBER}: read it, ground your answer in the code, and post the reply.`,
  maxTokens: 3072,
  maxTurns: 16,
  onTurn: (t) => console.log(`\n⟳  Turn ${t}`),
  onToolCall: (name, input) => console.log(`   🔧 ${name}(${Object.keys(input).join(', ')})`),
})

if (result.finalText) console.log('\n' + result.finalText)
console.log('\n✅ Discussion responder complete.')
