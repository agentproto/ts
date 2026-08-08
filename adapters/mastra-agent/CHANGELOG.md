# @agentproto/adapter-mastra-agent

## 0.4.0

### Minor Changes

- b29f6d3: Add three new git-backed workspace tools (read_diff, apply_patch, run_tests) with security validation (path escaping, command whitelisting), and introduce a pluggable extraTools mechanism for hosts to extend the toolset.

### Patch Changes

- 27c4fd2: Fix git operations escaping workspace to operate on enclosing parent repositories by setting GIT_CEILING_DIRECTORIES to prevent git from discovering repos above the workspace root.
- Updated dependencies [3e187e5]
- Updated dependencies [492240c]
  - @agentproto/driver-agent-cli@2.2.0
  - @agentproto/mastra@0.2.5

## 0.3.1

### Patch Changes

- c1399f3: Weekly dependency update: bump @modelcontextprotocol/sdk, @mastra/core and ecosystem packages, turbo, tsx, and React types to latest patch/minor versions within semver constraints.
- Updated dependencies [c1399f3]
  - @agentproto/mastra@0.2.4

## 0.3.0

### Minor Changes

- 831d4f5: Implement route-selection axis for AIP-45 launch-menu drill-down (WP1): add declarative `routeSelection` field to adapter manifests (distinguishes "free" vs. "derived-from-model"), project it through resolve/runtime layers, enrich catalog with per-route `multiModel` flags and flat routes index for tier-pinning logic.

### Patch Changes

- 04aedad: Weekly dependency bump with semver-safe minor/patch updates across 18 packages. Includes Mastra ecosystem update (1.31-1.48.x → 1.52.1), Claude SDK patch (0.3.200 → 0.3.220), build tool updates (turbo, tsx), and general dependency maintenance (yaml, ws, react, etc.). All changes verified to pass build, test, and type checks.
- Updated dependencies [c736c02]
- Updated dependencies [8367648]
- Updated dependencies [93e6309]
- Updated dependencies [c506d87]
- Updated dependencies [392021a]
- Updated dependencies [3865de6]
- Updated dependencies [5643cb6]
- Updated dependencies [42f1217]
- Updated dependencies [4542ca3]
- Updated dependencies [c064bc7]
- Updated dependencies [04aedad]
- Updated dependencies [4832ced]
  - @agentproto/driver-agent-cli@2.1.0
  - @agentproto/mastra@0.2.3

## 0.2.1

### Patch Changes

- Updated dependencies [cc00682]
  - @agentproto/driver-agent-cli@2.0.1

## 0.2.0

### Minor Changes

- cd4ad1a: Declare an `agent` manifest option so agent_start can pick the AGENT.md

### Patch Changes

- c850b1b: Infer anthropic for bare claude model ids; grant team agents their workspace tools
- Updated dependencies [1411e36]
- Updated dependencies [b16bb83]
- Updated dependencies [a021138]
- Updated dependencies [9fab1ad]
- Updated dependencies [92c1c51]
- Updated dependencies [48c55d5]
  - @agentproto/driver-agent-cli@2.0.0

## 0.1.5

### Patch Changes

- Updated dependencies [dd3386d]
- Updated dependencies [2f8ba2d]
- Updated dependencies [68d3093]
  - @agentproto/driver-agent-cli@1.2.0

## 0.1.4

### Patch Changes

- 9cec8c5: Add structured models.allowed entries to fix gateway model mode binding in VS Code picker
- Updated dependencies [9cec8c5]
- Updated dependencies [8d73291]
  - @agentproto/driver-agent-cli@1.1.0

## 0.1.3

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
- Updated dependencies [049c2fe]
- Updated dependencies [0ea6fc1]
- Updated dependencies [386a573]
- Updated dependencies [c036f59]
- Updated dependencies [76747fc]
- Updated dependencies [d425044]
- Updated dependencies [2d94149]
  - @agentproto/agent@0.2.1
  - @agentproto/driver-agent-cli@1.0.0
  - @agentproto/mastra@0.2.2

## 0.1.2

### Patch Changes

- 4c88fe1: Stop advertising Anthropic models in adapter model menus
- Updated dependencies [6b8b023]
- Updated dependencies [7142f1c]
- Updated dependencies [6f867e1]
- Updated dependencies [6c83622]
- Updated dependencies [3a76562]
- Updated dependencies [b65ca15]
- Updated dependencies [a28bebc]
- Updated dependencies [7f8b45a]
  - @agentproto/driver-agent-cli@0.4.0
  - @agentproto/mastra@0.2.1

## 0.1.1

### Patch Changes

- 2d1434a: Add mastra-jsonl print-arm schema, AgentCliPrintConfig, and adapter-mastracode
- Updated dependencies [06132bc]
- Updated dependencies [2d1434a]
- Updated dependencies [1bf295b]
- Updated dependencies [83aa850]
- Updated dependencies [872226b]
- Updated dependencies [78d09e6]
- Updated dependencies [559cff3]
- Updated dependencies [06132bc]
- Updated dependencies [c2b6779]
- Updated dependencies [e27fc94]
- Updated dependencies [837967a]
  - @agentproto/driver-agent-cli@0.3.0

## 0.1.0

### Minor Changes

- c3cd0cc: Add @agentproto/adapter-mastra-agent first-party Mastra-backed ACP agent
- 3066798: Add workspace toolset (list_dir/read_file/write_file/edit_file/run_command) and SQLite memory to mastra-agent
- d2566f0: Relay tool calls as ACP tool_call/tool_call_update via fullStream

### Patch Changes

- Updated dependencies [04c9a5a]
- Updated dependencies [adf4583]
- Updated dependencies [c6a90e2]
- Updated dependencies [7542339]
- Updated dependencies [5c2063e]
- Updated dependencies [0022b2a]
- Updated dependencies [6587000]
- Updated dependencies [a16968b]
- Updated dependencies [04c9a5a]
  - @agentproto/driver-agent-cli@0.2.0
  - @agentproto/mastra@0.2.0
