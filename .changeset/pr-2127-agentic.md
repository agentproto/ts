---
"@agentproto/apps": patch
"@agentproto/runtime": minor
---

Send the repo-maintenance notify step through the provider-agnostic `transmit_message` primitive (with an optional `notify` target of `{ provider, alias, address, source }`) instead of a hardcoded agentpush MCP alias, and allow `transmit_message` to send fire-and-forget with `bind: false` and no `sessionId`.
