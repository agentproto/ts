---
"@agentproto/runtime": minor
---

Add a persisted, bounded `dedupeKey` to prompt admission (`enqueuePrompt` and the MCP `agent_prompt` tool) so a retried prompt is delivered at most once inside a 24 hour window, returning `delivery: "duplicate"` with no delivery or queue mutation.
