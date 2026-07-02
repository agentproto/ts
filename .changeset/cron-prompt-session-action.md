---
"@agentproto/runtime": minor
"@agentproto/cli": patch
---

Add a `prompt-session` cron action kind that re-prompts an existing, already-running session instead of always spawning a new one. Lets a cron job periodically check in on a durable session with accumulated conversation context, rather than starting from zero every tick. CLI: `agentproto cron add --target-session <id> --prompt <text>`.
