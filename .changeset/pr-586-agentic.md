---
"@agentproto/runtime": minor
---

Add Mode 3 (self-refreshing OAuth) support for subscription credentials. Allows the runtime to read the Claude Code OAuth token fresh from the local login on every spawn via the `claude-code-oauth` provision recipe, implementing automatic token refresh without static token management.

New exports: `resolveSubscriptionCredential()`, `SubscriptionSourceError`, `CLAUDE_CODE_OAUTH_SOURCE`, extended `CredentialSource` type.

Fixes precedence logic (explicit-token > source-resolved-fresh > config-static-token) and adds loud error handling for unknown sources or resolution failures.
