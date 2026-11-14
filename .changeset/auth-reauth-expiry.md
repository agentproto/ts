---
"@agentproto/auth": minor
"@agentproto/adapter-opencode": minor
"@agentproto/cli": minor
"@agentproto/runtime": patch
---

Re-authentication is a first-class verb, per PARENT account. `agentproto auth reauth <profile|parent> [--check] [--json]` runs the parent's own login (opencode-console fully; claude-code, codex and gemini by delegating to their CLI, or saying what to run when it cannot be automated), then verifies the result, reports side effects such as a moved active account, and says what it could not check. One reauth fixes every sub-account profile under that parent, and switching sub-account never needs a re-login. `@agentproto/auth` adds the `ReauthAdapter` registry (one small module per source), `deriveAuthState`, `profileAuthStatus` and the `AuthReauthRequiredError` / `reauthHintOf` seam. `auth profile list` and `auth status` show `expiresAt` and a derived `state` (ok | expiring | expired | unknown) read from the parent account, plus the parent id for a sub-account profile, never a token. A spawn that fails because the owning parent's session is expired or missing now names the `agentproto auth reauth ...` command in the message and in `details.reauth`, instead of a bare 403.
