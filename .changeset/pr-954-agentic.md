---
"@agentproto/app-client": minor
"create-agentproto-app": minor
"@agentproto/cli": minor
---

Add `@agentproto/app-client` — a typed client for the `window.McpApp` bridge with TanStack Query React hooks supporting host/bridge/standalone mode fallback.

Add `create-agentproto-app` — a CLI scaffolder for new agentproto agent apps with Vite + React + TanStack Router/Query UI.

Add `app build`, `app dev`, `app pack`, `app serve` CLI verbs to build, develop, package, and serve agent apps. Refactor `app-serve.ts` exports to share bridge logic with `app dev`.
