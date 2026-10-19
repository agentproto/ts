---
"@agentproto/apps": patch
"@agentproto/runtime": patch
---

Send the repo-maintenance notify step through the provider-agnostic `transmit_message` primitive (with an optional `notify` target of `{ provider, alias, address }`) instead of a hardcoded agentpush MCP alias; allow `transmit_message` to send with `bind: false` and no `sessionId`.
