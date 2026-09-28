---
"@agentproto/app-kit": patch
---

Republish: `peekAppUi`, the `loadAppHandle` re-export, and `loadAppBundledTools` were added in #1470 but never versioned, so the published `1.3.0` predates them. This broke every fresh `@agentproto/cli@1.1.0` install (`SyntaxError: ... does not provide an export named 'peekAppUi'` on `agentproto --version`, since cli's built `cli.mjs` imports it from `@agentproto/app-kit@1.3.0`). Same failure mode as the `0.3.0` republish (auth/app-kit skew, #468/#470) — no code change, version-only.
