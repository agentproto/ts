---
"@agentproto/app-kit": minor
"@agentproto/cli": minor
"@agentproto/runtime": minor
---

`app serve` now honours APP.md frontmatter `ui.path` when resolving the UI root (falling back to the legacy `.agentproto/ui/`), fails with a clear exit-2 error when the resolved UI root is missing, and sandbox app serves carry the in-box serve-log error text on `SessionAppServeInfo.message`. Adds exported `resolveAppUIRoot` (app-kit), `createAppServeRequestHandler` (cli), and `serveLogPath`/`extractServeError` (runtime).
