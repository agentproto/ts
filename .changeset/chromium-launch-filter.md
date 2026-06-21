---
"@agentproto/adapter-browser": patch
---

Fix the chromium adapter's default launch command. The pnpm filter referenced a non-existent package name (`@browser/service`); the real package is `@agstudio/browser-service`, so `agentproto browser start chromium` never booted the browser service and `ensure` timed out on the health probe. Corrected the filter (plus the matching help/prompt text) so the chromium service launches autonomously from the daemon cwd (the monorepo root).
