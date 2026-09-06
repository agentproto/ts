# @agentproto/code-brain

## 0.3.2

### Patch Changes

- Updated dependencies [20ef731]
  - @agentproto/tool@0.3.0
  - @agentproto/driver-cli@0.1.6
  - @agentproto/driver@0.2.2
  - @agentproto/driver-http@0.1.6
  - @agentproto/driver-mcp@0.1.6

## 0.3.1

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
  - @agentproto/driver-cli@0.1.5
  - @agentproto/driver-http@0.1.5
  - @agentproto/driver-mcp@0.1.5
  - @agentproto/tool@0.2.2

## 0.3.0

### Minor Changes

- 7e00adb: Add `queryManySources` utility for client-side multi-source fan-out queries. Parallelizes `graphQuery` calls across multiple sources, deduplicates results by file+span (with title+body fallback), and returns a single score-ranked hit list.

## 0.2.0

### Minor Changes

- 5b10858: Introduce @agentproto/code-brain: pure, backend-agnostic code-intelligence contract with the AIP-14 `ask_codebase` tool, AIP-30 builtin provider, and AIP-29/31/32 surface projections (CLI, HTTP, MCP).

### Patch Changes

- Updated dependencies [831d4f5]
  - @agentproto/driver@0.2.0
  - @agentproto/driver-cli@0.1.4
  - @agentproto/driver-http@0.1.4
  - @agentproto/driver-mcp@0.1.4
