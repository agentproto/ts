---
"@agentproto/auth": minor
"@agentproto/runtime": minor
"@agentproto/vscode": minor
---

Add support for source-backed auth profiles — named profiles that resolve credentials fresh from self-refreshing sources (e.g. `claude-code-oauth`) instead of storing a static secret. Session spawn resolves source-backed profiles via Mode 3 credential resolution on every spawn; session restart explicitly rejects them (out of scope for restart, follow-up planned).

- `AuthProfile.credentialRef` now optional, new mutually-exclusive `source` field
- `validateCreateInput` enforces exactly one of `credential`/`source` for oauth-bearer, requires `credential` for api-key
- Session spawn: source-backed profiles resolve fresh credential each time via `resolveSubscriptionCredential`
- Session restart: source-backed profiles fail loud with `RestartOverrideError`
- New tests: profile provisioning with source, session spawn with source, restart rejection of source
