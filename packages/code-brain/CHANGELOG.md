# @agentproto/code-brain

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
