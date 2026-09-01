# @agentproto/app-client

## 0.2.2

### Patch Changes

- f0c51a7: Weekly dependency bump: update 9 minor/patch dependencies to latest versions.
  - @anthropic-ai/claude-agent-sdk 0.3.241 → 0.3.251
  - @ast-grep/napi 0.45.2 → 0.45.3
  - @earendil-works/pi-tui 0.84.2 → 0.84.4
  - @tanstack/react-query 5.102.2 → 5.102.8
  - @testing-library/react 16.3.2 → 16.3.3
  - e2b 2.45.0 → 2.46.1
  - tsx 4.23.12 → 4.23.13
  - turbo 2.10.11 → 2.10.12
  - zod 4.4.3 → 4.5.4

  No code changes; pnpm-lock.yaml updated to reflect new dependency versions.

## 0.2.1

### Patch Changes

- b95e23b: Weekly dependency update: bump external dependencies to latest minor/patch versions.
  - @anthropic-ai/claude-agent-sdk 0.3.233 → 0.3.241
  - @ast-grep/napi 0.45.1 → 0.45.2
  - @mastra/core 1.59.0 → 1.61.0
  - @mastra/libsql 1.20.0 → 1.21.1
  - @mastra/memory 1.26.2 → 1.27.0
  - @tanstack/react-query 5.66.0 → 5.102.2
  - @types/react-dom 19.2.4 → 19.2.5
  - @types/vscode 1.90.0 → 1.134.0
  - e2b 2.39.0 → 2.45.0
  - mastracode 0.33.1 → 0.35.0
  - turbo 2.10.10 → 2.10.11

  No code changes; pnpm-lock.yaml updated to reflect new dependency versions.

## 0.2.0

### Minor Changes

- c33e432: Add `@agentproto/app-client` — a typed client for the `window.McpApp` bridge with TanStack Query React hooks supporting host/bridge/standalone mode fallback.

  Add `create-agentproto-app` — a CLI scaffolder for new agentproto agent apps with Vite + React + TanStack Router/Query UI.

  Add `app build`, `app dev`, `app pack`, `app serve` CLI verbs to build, develop, package, and serve agent apps. Refactor `app-serve.ts` exports to share bridge logic with `app dev`.
