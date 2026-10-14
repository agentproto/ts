---
"@agentproto/adapter-claude-code-cloud": patch
---

Refresh an expired claude.ai OAuth login (via `claude -p`) and drop the stale keychain credential cache before retrying, so a re-attach after the token expired no longer 401s
