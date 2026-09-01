# @agentproto/workflow-runtime

## 0.8.1

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

- Updated dependencies [f0c51a7]
  - @agentproto/driver@0.2.1
  - @agentproto/tool@0.2.2
  - @agentproto/workflow@0.3.1

## 0.8.0

### Minor Changes

- b1a8b7e: Add declarative `onError: "collect"` support to workflow map steps. The runtime previously supported per-item error collection via `MapStep.onError`, but the declarative manifest layer did not expose this field. This change:
  - Adds `onError?: "throw" | "collect"` to the `StepMap` interface in `@agentproto/workflow`
  - Updates the compiler to read and propagate `onError` from declarative steps to compiled runtime steps
  - Includes comprehensive test coverage for the collection behavior with mixed success/failure outcomes

### Patch Changes

- Updated dependencies [b1a8b7e]
  - @agentproto/workflow@0.3.0

## 0.7.0

### Minor Changes

- 087f0ea: Declarative agent steps for AIP-15 workflows (WP-B4): author `kind:"agent"` steps with `agent.ref` (app-scoped agent ids) that resolve at compile time to concrete adapters + spawn options. Includes app installation/lifecycle tools (`app_install`, `app_run`, `app_list`, `app_status`, `app_stop`) for managing installed-app state and running agents as live sessions. Tool-id validation now shifts from STEP-DISPATCH time to INSTALL time, listing all missing ids upfront instead of failing one-at-a-time.
- 5e75a57: Add progressive step status reporting to workflow execution via optional `onStepStart` and `onStepComplete` callbacks. Steps now transition through pending → running → done states during execution, rather than remaining pending until workflow completion. This enables real-time progress tracking for long-running workflows.
- 2962637: **Feature: Agent step output text threading in workflows**

  Agent steps can now automatically capture their text output and inject it into subsequent steps' prompts, enabling multi-step workflows to share context and analysis. The workflow runtime captures the final message from each agent step (when `readFinalMessage` is available) and threads it through the bindings, making it accessible to downstream steps via the AIP-16 Selector pattern. Previous step outputs are formatted as `[Output from step "id"]\ntext` and prepended to the base prompt, improving agent reasoning across sequential steps.

### Patch Changes

- Updated dependencies [087f0ea]
  - @agentproto/workflow@0.2.0

## 0.6.0

### Minor Changes

- 23fa73e: Wire daemon tool-step registry into compileWorkflow; dogfood worktree-gc→notify

### Patch Changes

- Updated dependencies [831d4f5]
- Updated dependencies [23fa73e]
  - @agentproto/driver@0.2.0
  - @agentproto/workflow@0.1.1

## 0.5.0

### Minor Changes

- 57d1499: Route sandboxed agent-step spawns through spawnAgentSession; e2b installPackages boot option

## 0.4.0

### Minor Changes

- e0fbccc: Add opt-in per-item error tolerance (onError: "collect") to map/pipeline steps

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
  - @agentproto/driver@0.1.3
  - @agentproto/tool@0.2.1
  - @agentproto/workflow@0.1.0

## 0.3.0

### Minor Changes

- 7aaf24a: Add AgentStep.cwd selector and new worktree provision/gate/cleanup tools

### Patch Changes

- f8ebe41: Pass agent steps through the compiler unchanged
- 2154ed5: Pass agent steps through the compiler unchanged

## 0.2.0

### Minor Changes

- caab49e: Add AgentStep kind and AgentSessionHost; wire WorkflowRunner onto the interpreter
- 3cfe18a: Add outputSchema/maxRetries to AgentStep with validate-and-retry loop
- 887ea34: Add run-level cost ceiling (maxTotalCostUsd) and AgentSessionHost.readCostUsd
- 987db7b: Add PipelineStep: no-barrier staged concurrency over N items through K stages
- 4b76485: Add opt-in journal cache for cacheable steps — replay unchanged outputs on re-invocation

### Patch Changes

- a5c4701: Add package README and CLI concepts/workflows docs page

## 0.1.2

### Patch Changes

- Updated dependencies [78ac79e]
- Updated dependencies [dc870cf]
- Updated dependencies [2186e9e]
  - @agentproto/tool@0.2.0
  - @agentproto/driver@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [1fc1750]
- Updated dependencies [1fc1750]
  - @agentproto/driver@0.1.1
  - @agentproto/tool@0.1.1

## 0.1.0

### Patch Changes

- Updated dependencies [44192c9]
  - @agentproto/driver@0.1.0
  - @agentproto/tool@0.1.0
