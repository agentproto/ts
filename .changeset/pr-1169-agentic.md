---
"@agentproto/adapter-opencode": minor
"@agentproto/cli": patch
"@agentproto/runtime": patch
---

Add token usage tracking for OpenCode adapter sessions via readOpenCodeUsage hook. OpenCode's live ACP usage_update event only carries cost (no token fields), so the new function reads token data from OpenCode's sqlite store and is wired into the registry's turn-end path to fill in missing tokensIn/tokensOut fields, mirroring the existing hermes adapter pattern.
