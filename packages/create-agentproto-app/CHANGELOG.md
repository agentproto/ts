# create-agentproto-app

## 0.3.0

### Minor Changes

- 4d01e5c: Add the "book contract" — optional `category` + `library.books` fields to app definitions, allowing apps to self-identify as book bundles for catalog/library substrates. Includes validation, round-trip support, and a new `--template book` option in create-agentproto-app, bundled with an `install-agentproto-app` skill for tier-1 installs.

### Patch Changes

- 3e30df8: `agentproto app init <template> [dir]` — scaffold an app from a template
  (react-ts | vanilla | book | trame) by wrapping `create-agentproto-app`'s
  `scaffoldApp`; the new `trame` template emits the minimal AIP app trame
  (one agent, one workflow with a harness-pinned agent step + gate, a
  single-file UI stage board, an example gate, the verify umbrella, the
  data-plane key dictionary, and a node:test suite).

  `agentproto app validate [dir] [--json]` — check an app against the
  loaders: `loadAppHandle`, every declared workflow via `loadWorkflow`,
  `ui.tools` entries against the known daemon tool surface (plus `app_*`),
  `data/DATA.md` presence when `data.dir` is declared, and the APP.md
  `verify.command` run argv-split (no shell) from the app dir with its exit
  code propagated.

- aff7794: Add `@agentproto/app-client/runner-select` — a shared harness+model selector for app UIs that discovers installed harnesses via `adapter_list` + `harness_preset_list`, eliminating per-app picker implementations. Automatically injected into every app UI alongside the McpApp bridge. Supporting changes: `adapter_list` summary mode for lightweight UI projections, harness preset profile status enrichment (disabled/missing flags), early validation of default preset profiles during spawn, and discovery tool allowlisting for all app UIs.
- Updated dependencies [aff7794]
  - @agentproto/app-client@0.3.0

## 0.2.2

### Patch Changes

- Updated dependencies [f0c51a7]
  - @agentproto/app-client@0.2.2

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
