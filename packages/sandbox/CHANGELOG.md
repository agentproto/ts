# @agentproto/sandbox

## 0.3.0

### Minor Changes

- db90fb3: Implement port exposure for sandboxes. Add `expose(port)` method and `ports` map to `BootedSandbox` to enable agents to expose HTTP server ports inside sandboxes as publicly accessible URLs. Support pre-declaring ports via `extraPorts` in the sandbox spec for eager resolution at boot time. E2B provider implements port exposure via `sandbox.getHost(port)`. Surface exposed ports in `SessionDescriptor` and `SessionSummary` via new `sandboxPorts` field.
- c71753a: Add `agent_start.appServe`: with `sandbox`, the daemon installs the app on the box (the box daemon's `app_install`), launches `agentproto app serve --host 0.0.0.0 --port <port>` detached through the box's `command_execute` (seeding the box command allowlist), and stamps the public URL on the descriptor/result; `SandboxAgentSessionHost` now carries `mcpUrl` so callers can drive the box's other daemon tools.

### Patch Changes

- Updated dependencies [c4bff00]
- Updated dependencies [f9e21fd]
- Updated dependencies [c4ebbd3]
- Updated dependencies [80c837e]
- Updated dependencies [a48dc03]
- Updated dependencies [1cd0220]
- Updated dependencies [ece3cae]
- Updated dependencies [e7e9261]
- Updated dependencies [a04bd29]
- Updated dependencies [fe9a374]
  - @agentproto/workflow-runtime@0.10.0
  - @agentproto/worktree@0.6.0
  - @agentproto/define-doctype@0.1.1
  - @agentproto/secrets@0.2.4

## 0.2.6

### Patch Changes

- Updated dependencies [11b5564]
- Updated dependencies [2fc4c69]
  - @agentproto/workflow-runtime@0.9.0
  - @agentproto/worktree@0.5.5

## 0.2.5

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
  - @agentproto/secrets@0.2.4
  - @agentproto/workflow-runtime@0.8.1
  - @agentproto/worktree@0.5.4

## 0.2.4

### Patch Changes

- Updated dependencies [76f2c78]
- Updated dependencies [e3ad769]
- Updated dependencies [6372c19]
- Updated dependencies [8a3d53d]
- Updated dependencies [c5016ed]
- Updated dependencies [b1a8b7e]
  - @agentproto/secrets@0.2.3
  - @agentproto/worktree@0.5.3
  - @agentproto/workflow-runtime@0.8.0

## 0.2.3

### Patch Changes

- Updated dependencies [5f5b1bc]
  - @agentproto/worktree@0.5.2

## 0.2.2

### Patch Changes

- Updated dependencies [4b6bbe6]
- Updated dependencies [087f0ea]
- Updated dependencies [5e75a57]
- Updated dependencies [2962637]
  - @agentproto/worktree@0.5.1
  - @agentproto/workflow-runtime@0.7.0

## 0.2.1

### Patch Changes

- Updated dependencies [c1399f3]
- Updated dependencies [8228d88]
- Updated dependencies [fd3e287]
  - @agentproto/worktree@0.5.0

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
