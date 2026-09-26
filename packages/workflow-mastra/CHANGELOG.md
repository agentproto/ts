# @agentproto/workflow-mastra

## 0.2.0

### Minor Changes

- 67c5ee5: Projected workflows now carry real schemas instead of `z.any()` everywhere: the workflow's own `inputSchema` is built from the declared AIP-16 `inputs` block (rejecting invalid input before any step runs), and tool/agent steps project their real declared `outputSchema`. A top-level `suspend`/`approval` step now projects to native Mastra `suspend()`/`resume()` instead of failing loud (still refused when nested inside a branch/parallel/loop/map/group, where there's no per-step suspend boundary). `gate` is now refused explicitly with a stated reason instead of silently reaching an unhandled case in the local step-walker. Adds an AIP-58 conformance harness (`aip58-conformance.mastra.test.ts`) driving the same vendored vectors through `toMastraWorkflow` — V1 green, V2-V8 tracked as `it.todo`.

### Patch Changes

- Updated dependencies [c3314bd]
- Updated dependencies [cd00daa]
- Updated dependencies [7c059bc]
- Updated dependencies [582b79c]
- Updated dependencies [579227e]
- Updated dependencies [6c68009]
- Updated dependencies [1e871ec]
- Updated dependencies [5a466d6]
- Updated dependencies [9a5d311]
- Updated dependencies [bdb5830]
  - @agentproto/workflow-runtime@0.13.0
  - @agentproto/driver@0.2.4

## 0.1.11

### Patch Changes

- Updated dependencies [41b8b76]
- Updated dependencies [854db1f]
  - @agentproto/workflow-runtime@0.12.0

## 0.1.10

### Patch Changes

- c27f0b8: Weekly minor/patch dependency bumps across workspaces (zod, @mastra/*, react, yaml, claude-agent-sdk, etc.).
- Updated dependencies [c27f0b8]
  - @agentproto/driver@0.2.3
  - @agentproto/tool@0.3.1
  - @agentproto/workflow-runtime@0.11.1

## 0.1.9

### Patch Changes

- Updated dependencies [c809f12]
  - @agentproto/workflow-runtime@0.11.0

## 0.1.8

### Patch Changes

- 81752fa: Update upstream dependencies for improved compatibility and stability: @anthropic-ai/claude-agent-sdk (0.3.263), @mastra/core (1.64.0), @mastra/memory (1.28.2), @types/react-dom (19.2.7), and @tauri-apps/plugin-opener (2.5.5).
- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [2f37e7b]
- Updated dependencies [20ef731]
  - @agentproto/driver@0.2.2
  - @agentproto/tool@0.3.0
  - @agentproto/workflow-runtime@0.10.1

## 0.1.7

### Patch Changes

- Updated dependencies [c4bff00]
- Updated dependencies [f9e21fd]
- Updated dependencies [c4ebbd3]
- Updated dependencies [a48dc03]
- Updated dependencies [1cd0220]
- Updated dependencies [ece3cae]
- Updated dependencies [e7e9261]
- Updated dependencies [a04bd29]
- Updated dependencies [fe9a374]
  - @agentproto/workflow-runtime@0.10.0
  - @agentproto/driver@0.2.1
  - @agentproto/tool@0.2.2

## 0.1.6

### Patch Changes

- Updated dependencies [11b5564]
  - @agentproto/workflow-runtime@0.9.0

## 0.1.5

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
  - @agentproto/workflow-runtime@0.8.1

## 0.1.4

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

- Updated dependencies [b1a8b7e]
  - @agentproto/workflow-runtime@0.8.0

## 0.1.3

### Patch Changes

- e68c999: Weekly minor/patch dependency bump (w33). Fixes `TUI` class → `TuiMainScreen` rename from `@earendil-works/pi-tui` 0.84.1.

## 0.1.2

### Patch Changes

- Updated dependencies [087f0ea]
- Updated dependencies [5e75a57]
- Updated dependencies [2962637]
  - @agentproto/workflow-runtime@0.7.0

## 0.1.1

### Patch Changes

- c1399f3: Weekly dependency update: bump @modelcontextprotocol/sdk, @mastra/core and ecosystem packages, turbo, tsx, and React types to latest patch/minor versions within semver constraints.

## 0.1.0

### Minor Changes

- d973ce1: WORKFLOW.md → Mastra createWorkflow / Vercel AI SDK export projections

### Patch Changes

- 04aedad: Weekly dependency bump with semver-safe minor/patch updates across 18 packages. Includes Mastra ecosystem update (1.31-1.48.x → 1.52.1), Claude SDK patch (0.3.200 → 0.3.220), build tool updates (turbo, tsx), and general dependency maintenance (yaml, ws, react, etc.). All changes verified to pass build, test, and type checks.
- Updated dependencies [831d4f5]
- Updated dependencies [23fa73e]
  - @agentproto/driver@0.2.0
  - @agentproto/workflow-runtime@0.6.0
