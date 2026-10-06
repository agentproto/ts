---
"@agentproto/adapter-opencode": patch
"@agentproto/cli": patch
---

Docs updates: the opencode adapter descriptor now passes `--print-logs --log-level ERROR` to `opencode-ai acp` to quiet noisy stdout logs, and the daemon turn-stall docs (`turnStallAfterMs`) now describe the new `lastTurnErrorMessage: "no output since prompt — provider retrying?"` marker for turns that produced no output or usage since their prompt (e.g. a provider silently retrying after a swallowed 429).
