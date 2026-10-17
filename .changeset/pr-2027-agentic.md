---
"@agentproto/adapter-browser-chrome": patch
"@agentproto/cli": patch
---

Documentation sync for already-shipped features. The browser-chrome README now documents the `createChromeLiveProvider({ cookieSource })` dedicated-Chrome cookie-injection seam and scopes the read-only cookie guarantee to the user's own attached Chrome. The CLI package README and `docs/cli` verb references now cover `agentproto sessions report`, `agentproto mcp login`/`logout` (OAuth 2.1 for remote imports), `agentproto workspace check` (AIP-34 `workspace/v2` tree verification), and the `AGENTPROTO_BROWSER_OBSERVER_*` daemon env vars.
