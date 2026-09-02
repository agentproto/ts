# @agentproto/mastra

## 0.2.10

### Patch Changes

- Updated dependencies [4fb28be]
  - @agentproto/corpus@0.7.0

## 0.2.9

### Patch Changes

- Updated dependencies [2ac7025]
- Updated dependencies [dee9bd8]
- Updated dependencies [5864268]
- Updated dependencies [f0c51a7]
- Updated dependencies [b7d9221]
  - @agentproto/corpus@0.6.0
  - @agentproto/agent@0.2.2

## 0.2.8

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
  - @agentproto/corpus@0.5.2

## 0.2.7

### Patch Changes

- bd5faae: Fix Anthropic API crashes on trailing reasoning blocks by wiring ProviderHistoryCompat input processor to strip reasoning-type content from assistant messages before sending to the model provider.

## 0.2.6

### Patch Changes

- e68c999: Weekly minor/patch dependency bump (w33). Fixes `TUI` class → `TuiMainScreen` rename from `@earendil-works/pi-tui` 0.84.1.

## 0.2.5

### Patch Changes

- @agentproto/corpus@0.5.1

## 0.2.4

### Patch Changes

- c1399f3: Weekly dependency update: bump @modelcontextprotocol/sdk, @mastra/core and ecosystem packages, turbo, tsx, and React types to latest patch/minor versions within semver constraints.
- Updated dependencies [bdba3a5]
  - @agentproto/corpus@0.5.0

## 0.2.3

### Patch Changes

- 04aedad: Weekly dependency bump with semver-safe minor/patch updates across 18 packages. Includes Mastra ecosystem update (1.31-1.48.x → 1.52.1), Claude SDK patch (0.3.200 → 0.3.220), build tool updates (turbo, tsx), and general dependency maintenance (yaml, ws, react, etc.). All changes verified to pass build, test, and type checks.
- Updated dependencies [c4f2908]
- Updated dependencies [8a4fed0]
- Updated dependencies [04aedad]
  - @agentproto/corpus@0.4.0

## 0.2.2

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
- Updated dependencies [d89f0ad]
- Updated dependencies [a59c2d8]
- Updated dependencies [e4d9087]
- Updated dependencies [67aabc9]
  - @agentproto/agent@0.2.1
  - @agentproto/corpus@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [9ab5473]
  - @agentproto/corpus@0.2.1

## 0.2.0

### Minor Changes

- a16968b: Add CorpusHost, assembleDimensions, overlay processor factory, and query knowledge tool

### Patch Changes

- Updated dependencies [a5b12cf]
- Updated dependencies [7d1b98c]
- Updated dependencies [a16968b]
  - @agentproto/corpus@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies [1fc1750]
- Updated dependencies [1fc1750]
  - @agentproto/agent@0.2.0

## 0.1.0

### Patch Changes

- Updated dependencies [44192c9]
  - @agentproto/agent@0.1.0
