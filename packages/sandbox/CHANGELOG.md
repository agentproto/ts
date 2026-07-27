# @agentproto/sandbox

## 0.2.0

### Minor Changes

- e81ad25: Add `agentproto sandbox attach` — Phase 1 of AIP-36 sandbox reconnect. New CLI verb and runtime primitives (`attachSandbox`, `buildMcpConfigSnippet`, `registerSandboxAttachTool`) for connecting to already-existing sandboxes without tearing them down. Returns durable, token-gated connection descriptors for any MCP client to use directly. Extends `SandboxProvider` with optional `connect()` method for resume-after-pause workflows, and adds token capture from Box's `--private` and e2b's traffic restriction.
- 15abbee: Add `--keep-alive` flag to `agentproto sandbox attach` for always-on rendezvous model. Keeps sandboxes indefinitely awake using provider-specific mechanisms (e.g., Box's `ttlSeconds: null` no-auto-stop) instead of letting the provider's idle/TTL auto-stop reclaim them.

### Patch Changes

- 013e7b3: Carry provider auth headers through attach; fix Box boot auth
- Updated dependencies [7192faf]
- Updated dependencies [41cd652]
- Updated dependencies [7465b6c]
- Updated dependencies [4d200a9]
- Updated dependencies [23fa73e]
  - @agentproto/worktree@0.4.3
  - @agentproto/workflow-runtime@0.6.0
  - @agentproto/secrets@0.2.2

## 0.1.5

### Patch Changes

- @agentproto/secrets@0.2.1

## 0.1.4

### Patch Changes

- Updated dependencies [57d1499]
  - @agentproto/workflow-runtime@0.5.0
  - @agentproto/worktree@0.4.2

## 0.1.3

### Patch Changes

- Updated dependencies [a116fd6]
  - @agentproto/worktree@0.4.1

## 0.1.2

### Patch Changes

- Updated dependencies [98bbebf]
  - @agentproto/worktree@0.4.0

## 0.1.1

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
- Updated dependencies [5ae8c13]
- Updated dependencies [6d4aa4b]
- Updated dependencies [60792f1]
- Updated dependencies [4f62f46]
- Updated dependencies [8a4d5d5]
- Updated dependencies [2bed7e6]
- Updated dependencies [3639abd]
- Updated dependencies [3e99abf]
- Updated dependencies [a63b4bc]
- Updated dependencies [47d3251]
- Updated dependencies [a32bb69]
- Updated dependencies [e0fbccc]
- Updated dependencies [0839e5f]
  - @agentproto/define-doctype@0.1.1
  - @agentproto/secrets@0.2.0
  - @agentproto/workflow-runtime@0.4.0
  - @agentproto/worktree@0.3.0

## 0.1.0

### Minor Changes

- 126f7c6: Add createSandboxAgentSessionHost, e2b SandboxProvider, and re-export daemon host from worktree
- e029a35: Wire agent_start.sandbox: boot box + proxy session via SandboxAgentSessionProxy
- 553597a: Add sandbox reconnect/reuse and AIP-36 lifecycle pause support

### Patch Changes

- Updated dependencies [4a1ea0f]
- Updated dependencies [f8ebe41]
- Updated dependencies [7aaf24a]
- Updated dependencies [435dfbf]
- Updated dependencies [a6dce67]
- Updated dependencies [126f7c6]
- Updated dependencies [fe13f4e]
- Updated dependencies [829a6c0]
- Updated dependencies [4733077]
- Updated dependencies [e94757d]
- Updated dependencies [2154ed5]
- Updated dependencies [5988bf4]
- Updated dependencies [e029a35]
  - @agentproto/worktree@0.2.0
  - @agentproto/workflow-runtime@0.3.0
  - @agentproto/secrets@0.1.0
