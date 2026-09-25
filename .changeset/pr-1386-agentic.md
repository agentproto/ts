---
"@agentproto/acp": minor
"@agentproto/apps": patch
"@agentproto/model-catalog": minor
"@agentproto/runtime": minor
"@agentproto/transcript-fixtures": patch
"agentproto-desktop": patch
"agentproto-vscode": patch
---

Keep the reported context window sticky: a cost-bearing usage_update's size is authoritative and no longer downgraded by later inferred frames (claude-agent-acp guesses 200k for 1M models until its first result). The daemon seeds the window from the model catalog at spawn, carries the adapter's `_claude/model` and `sizeInferred` on usage_update events, records `reportedSize` when it corrects a size, and treats a trailing `[1m]` lane hint (`claude-opus-5-5[1m]`) as an explicit window choice — not part of model identity for pricing/alias lookups.
