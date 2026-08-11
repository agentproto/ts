# @agentproto/app-kit

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
