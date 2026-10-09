# @agentproto/driver-cli

## 0.2.4

### Patch Changes

- Updated dependencies [ab367ec]
  - @agentproto/tool@0.5.1
  - @agentproto/driver@0.3.2

## 0.2.3

### Patch Changes

- Updated dependencies [5b021a8]
  - @agentproto/tool@0.5.0
  - @agentproto/driver@0.3.1

## 0.2.2

### Patch Changes

- Updated dependencies [a68d1d6]
- Updated dependencies [4243c75]
  - @agentproto/driver@0.3.0
  - @agentproto/tool@0.4.0

## 0.2.1

### Patch Changes

- 036c9df: Fix a `kind: cli` tool step (and `kind: gate` step) hanging forever when the
  subprocess leaves an orphaned grandchild holding its stdout/stderr pipe open
  (e.g. a headless-Chrome renderer helper reparented to pid 1) — completion now
  settles on the direct child's own `exit` instead of waiting on the stdio
  `close` event, with a short drain window only as a ceiling. Both subprocess
  runners spawn detached and kill the whole process group on abort/timeout, so
  an orphan doesn't survive a cancel either. `tool` and `gate` steps also gain
  their own `timeout_ms` (new exported `DEFAULT_STEP_TIMEOUT_MS`, new
  `ToolStep.timeoutMs` field), defaulting to 10 minutes when unset.
  - @agentproto/driver@0.2.5
  - @agentproto/tool@0.3.2

## 0.2.0

### Minor Changes

- d6d86b6: App-bundled kind:cli drivers spawn subprocesses with the app root as cwd, with metadata.cli.cwd override

### Patch Changes

- Updated dependencies [cd00daa]
  - @agentproto/driver@0.2.4

## 0.1.7

### Patch Changes

- c27f0b8: Weekly minor/patch dependency bumps across workspaces (zod, @mastra/*, react, yaml, claude-agent-sdk, etc.).
- Updated dependencies [c27f0b8]
  - @agentproto/driver@0.2.3
  - @agentproto/tool@0.3.1

## 0.1.6

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [2f37e7b]
- Updated dependencies [20ef731]
  - @agentproto/driver@0.2.2
  - @agentproto/tool@0.3.0

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

## 0.1.4

### Patch Changes

- Updated dependencies [831d4f5]
  - @agentproto/driver@0.2.0

## 0.1.3

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
  - @agentproto/driver@0.1.3
  - @agentproto/tool@0.2.1

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
