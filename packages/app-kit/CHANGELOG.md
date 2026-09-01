# @agentproto/app-kit

## 0.7.1

### Patch Changes

- Updated dependencies [f0c51a7]
  - @agentproto/agent@0.2.2
  - @agentproto/workflow@0.3.1
  - @agentproto/workflow-loader@0.1.5
  - @agentproto/workspace@0.1.1
  - @agentproto/mastra@0.2.9

## 0.7.0

### Minor Changes

- 0097d36: Add a new opt-in, read-only external filesystem plane for installed apps: an app can declare `externalReadRoots` (a manifest field on `AppDefinition`/`AppHandle`/`AppFrontmatter`/`InstalledApp`) to be granted read access to a real host folder outside the daemon's sandbox — e.g. a user's actual `~/Downloads/applications` — without touching the existing app-data (app-owned dir) or fs-tools (workspace-root) planes.

  Each root is `~`-expanded, resolved absolute, and validated to exist as a real directory at install time (`app_install`/`app_apply` fail fast otherwise). Two new MCP tools (`app_external_list`, `app_external_read`) and a new `GET /apps/:appId/external-blob?root=&path=` HTTP route read from a granted root only when the caller's `root` argument is an exact match — no prefix/fuzzy matching. `app_external_read` serves only an allowlist of text-ish extensions under a 2MB cap; binary content (PDFs, images, …) streams through the HTTP route instead. There is no write or delete tool for these roots anywhere in the daemon.

### Patch Changes

- e2314b3: Weekly dependency update: minor/patch-range bumps across the workspace.
  - @mastra/core 1.57.0 → 1.59.0
  - @mastra/memory 1.26.0 → 1.26.2
  - @mastra/libsql 1.19.0 → 1.20.0
  - turbo 2.10.9 → 2.10.10
  - unpdf 1.8.0 → 1.8.1
  - e2b 2.38.2 → 2.39.0
  - @anthropic-ai/claude-agent-sdk 0.3.226/0.3.232 → 0.3.233
  - @earendil-works/pi-tui 0.84.1 → 0.84.2
  - mastracode 0.32.6 → 0.33.1

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

- Updated dependencies [e2314b3]
- Updated dependencies [b95e23b]
- Updated dependencies [b1a8b7e]
  - @agentproto/mastra@0.2.8
  - @agentproto/workflow@0.3.0
  - @agentproto/workflow-loader@0.1.4

## 0.6.1

### Patch Changes

- e418ec7: Documentation updates for new jcode adapter, MCP tool families, configuration enhancements, and Mastra adapter API changes.

## 0.6.0

### Minor Changes

- 33e97d3: Add skill surface to defineApp/emit and app_skill_get validation
- d22fec5: Add artifact surface to defineApp/emit for Cowork artifact registration

### Patch Changes

- 3d54f15: Add `agentproto app serve` command for serving app UIs as standalone webapps with MCP connectivity. Introduces optional `ui.port` field to AppUiDefinition, implements a static HTTP server with bridge script injection, and establishes MCP client proxying through a reserved `/__agentproto/tool-call` endpoint.
- Updated dependencies [bd5faae]
  - @agentproto/mastra@0.2.7

## 0.5.1

### Patch Changes

- 69e97d9: Documentation sync: version bumps, turn-liveness watchdog config details, UI surfaces/artifacts/dev-launch config examples, and agentproto-apps-sync binary documentation.
- Updated dependencies [e68c999]
  - @agentproto/mastra@0.2.6

## 0.5.0

### Minor Changes

- 4b73e28: Add UI, artifacts, and dev-launch configuration support to app-kit. Apps can now declare HTML surfaces, artifact types, and dev-launch configurations that are carried through emit/load and integrated into the runtime app registry.
- b098b52: Add UI, artifacts, and dev-launch configuration support to app-kit. Apps can now declare HTML surfaces, artifact types, and dev-launch configurations that are carried through emit/load and integrated into the runtime app registry.

## 0.4.0

### Minor Changes

- 47ca357: Add `loadAppHandle(dir)` function to load previously emitted app bundles, and support optional app identity fields (id/name/version/description) in `defineApp`. The emit now always writes a root `APP.md` index manifest that a future daemon `app_install` can discover and consume.
- 2b379e9: Add app dependency management and scope mount tracking. Introduces `requires` field on apps to declare dependencies, new MCP tools (`app_apply`, `app_unapply`, `app_list_applied`) for managing app mounts to scopes, HTTP endpoints mirroring the tools, and AppRegistry enhancements for persistence of applied mounts with dependency validation.

### Patch Changes

- 087f0ea: Declarative agent steps for AIP-15 workflows (WP-B4): author `kind:"agent"` steps with `agent.ref` (app-scoped agent ids) that resolve at compile time to concrete adapters + spawn options. Includes app installation/lifecycle tools (`app_install`, `app_run`, `app_list`, `app_status`, `app_stop`) for managing installed-app state and running agents as live sessions. Tool-id validation now shifts from STEP-DISPATCH time to INSTALL time, listing all missing ids upfront instead of failing one-at-a-time.
- Updated dependencies [087f0ea]
  - @agentproto/workflow@0.2.0
  - @agentproto/workflow-loader@0.1.3
  - @agentproto/mastra@0.2.5

## 0.3.2

### Patch Changes

- c1399f3: Weekly dependency update: bump @modelcontextprotocol/sdk, @mastra/core and ecosystem packages, turbo, tsx, and React types to latest patch/minor versions within semver constraints.
- Updated dependencies [c1399f3]
  - @agentproto/mastra@0.2.4

## 0.3.1

### Patch Changes

- 04aedad: Weekly dependency bump with semver-safe minor/patch updates across 18 packages. Includes Mastra ecosystem update (1.31-1.48.x → 1.52.1), Claude SDK patch (0.3.200 → 0.3.220), build tool updates (turbo, tsx), and general dependency maintenance (yaml, ws, react, etc.). All changes verified to pass build, test, and type checks.
- Updated dependencies [23fa73e]
- Updated dependencies [04aedad]
  - @agentproto/workflow@0.1.1
  - @agentproto/mastra@0.2.3

## 0.3.0

### Minor Changes

- a0b94fd: Republish auth (eligibleProfiles export, added in #470 but never versioned)
  and app-kit (WorkspaceShorthand / optional `workspace` on AppDefinition,
  added in #468 but never versioned) to fix npm publish skew — #468 touched
  `packages/app-kit/src/types.ts`, not `@agentproto/workspace`, so app-kit is
  the stale published artifact, not workspace.

## 0.2.0

### Minor Changes

- e3bacf3: Add app-kit pick()/only, fix content-team tools, self_inspect discovers app-emitted agents
