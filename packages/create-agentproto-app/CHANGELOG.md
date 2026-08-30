# create-agentproto-app

## 0.2.1

### Patch Changes

- Updated dependencies [b95e23b]
  - @agentproto/app-client@0.2.1

## 0.2.0

### Minor Changes

- c33e432: Add `@agentproto/app-client` — a typed client for the `window.McpApp` bridge with TanStack Query React hooks supporting host/bridge/standalone mode fallback.

  Add `create-agentproto-app` — a CLI scaffolder for new agentproto agent apps with Vite + React + TanStack Router/Query UI.

  Add `app build`, `app dev`, `app pack`, `app serve` CLI verbs to build, develop, package, and serve agent apps. Refactor `app-serve.ts` exports to share bridge logic with `app dev`.

- f3fa4e6: Add --template vanilla, stamp app-client version, honour ui.port in app dev

### Patch Changes

- Updated dependencies [c33e432]
  - @agentproto/app-client@0.2.0
