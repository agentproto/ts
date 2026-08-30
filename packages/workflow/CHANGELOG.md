# @agentproto/workflow

## 0.3.0

### Minor Changes

- b1a8b7e: Add declarative `onError: "collect"` support to workflow map steps. The runtime previously supported per-item error collection via `MapStep.onError`, but the declarative manifest layer did not expose this field. This change:
  - Adds `onError?: "throw" | "collect"` to the `StepMap` interface in `@agentproto/workflow`
  - Updates the compiler to read and propagate `onError` from declarative steps to compiled runtime steps
  - Includes comprehensive test coverage for the collection behavior with mixed success/failure outcomes

## 0.2.0

### Minor Changes

- 087f0ea: Declarative agent steps for AIP-15 workflows (WP-B4): author `kind:"agent"` steps with `agent.ref` (app-scoped agent ids) that resolve at compile time to concrete adapters + spawn options. Includes app installation/lifecycle tools (`app_install`, `app_run`, `app_list`, `app_status`, `app_stop`) for managing installed-app state and running agents as live sessions. Tool-id validation now shifts from STEP-DISPATCH time to INSTALL time, listing all missing ids upfront instead of failing one-at-a-time.

## 0.1.1

### Patch Changes

- 23fa73e: Wire daemon tool-step registry into compileWorkflow; dogfood worktree-gc→notify

## 0.1.0

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
  - @agentproto/define-doctype@0.1.1
