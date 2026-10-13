---
"@agentproto/runtime": minor
"@agentproto/workflow-runtime": minor
"@agentproto/agent": minor
"@agentproto/mastra": patch
"@agentproto/adapter-mastra-agent": patch
"@agentproto/cli": patch
---

An AIP-42 AGENT.md now reaches every harness, not just mastra-agent. `app_run` and workflow agent refs share one projection (`projectAgentToSpawn`): body, persona, boundaries and traits become the first prompt's prefix, declared tools scope a daemon gateway mount (`allowTools`) for any adapter, declared skills reach the spawn's `skills`, and each gap the harness can't honour raises a `session:harness-warning`. `composeInstructions` moves to `@agentproto/agent`. `app_run` spawns now get the daemon `/mcp` URL, workflow host spawns deliver session skills, and the AGENT.md path goes only to adapters whose manifest declares `metadata.agentManifestOption` (mastra-agent), so antigravity's `agent` option (an `agy` agent name) is no longer handed a path.
