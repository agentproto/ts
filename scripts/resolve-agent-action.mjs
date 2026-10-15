#!/usr/bin/env node

import { appendGithubOutputs, githubOutputs, readAgentConfig, resolveAgentAction, toReviewConfig } from './lib/agent-action-config.mjs'

const [actionName, ...flags] = process.argv.slice(2)
if (!actionName) throw new Error('usage: resolve-agent-action.mjs <action> [--review-config|--github-output]')

const config = readAgentConfig()
const resolved = resolveAgentAction(config, actionName, process.env, process.env.AGENT_BACKEND || '')

if (flags.includes('--review-config')) {
  process.stdout.write(JSON.stringify(toReviewConfig(config, resolved)))
} else if (flags.includes('--github-output')) {
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required with --github-output')
  appendGithubOutputs(process.env.GITHUB_OUTPUT, githubOutputs(resolved))
  console.log(`${actionName}: ${resolved.names.join(' -> ')}`)
} else {
  process.stdout.write(JSON.stringify({ ...resolved, outputs: githubOutputs(resolved) }, null, 2) + '\n')
}
