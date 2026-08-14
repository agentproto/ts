# @agentproto/adapter-mastra-agent

## 0.5.1

### Patch Changes

- e418ec7: Documentation updates for new jcode adapter, MCP tool families, configuration enhancements, and Mastra adapter API changes.
- 6d216da: Fix: drop reasoning-only assistant messages instead of injecting empty text blocks. The Mastra adapter was filtering out trailing reasoning blocks but then injecting empty text blocks as a fallback, which violates Anthropic's API contract ("text content blocks must be non-empty"). Now reasoning-only messages are properly dropped entirely, which is safe because they carry no tool calls.
- Updated dependencies [e418ec7]
- Updated dependencies [2e24a7e]
- Updated dependencies [27a22ca]
- Updated dependencies [59d23d1]
- Updated dependencies [2120494]
- Updated dependencies [42ca610]
- Updated dependencies [6b04734]
- Updated dependencies [0b4a84b]
- Updated dependencies [231f015]
- Updated dependencies [ce7cbb7]
- Updated dependencies [4474e5e]
- Updated dependencies [5de8be3]
- Updated dependencies [f96dc2a]
- Updated dependencies [cbe11c2]
- Updated dependencies [a0558d4]
- Updated dependencies [140874a]
  - @agentproto/runtime@2.7.0
  - @agentproto/driver-agent-cli@2.3.0

## 0.5.0

### Minor Changes

- 75e47e2: Major architectural refactor: shift from raw stream-based event handling to Mastra's `AgentController` event subscription model. Adds comprehensive support for plan/build/review modes, tool approvals, daemon integration (sub-agent spawning, session notifications, state signals), and session resume. New public APIs: `promptContent` (multimodal prompt parsing), modes parsing and configuration, daemon client, signal provider, tool-approval and suspension bridges.

### Patch Changes

- 790f351: Send Anthropic OAuth access tokens as Bearer auth instead of x-api-key
- c1e1807: Fix tool resolution failures in mastra-agent adapter: introduce fail-fast stubs for declared-but-unwired tools (preventing hangs), wrap all tools with timeout guards (preventing unbounded blocking), add daemon-style tool ID aliases (fixing vocabulary mismatches in AGENT.md files), and properly handle tool-error chunks from Mastra (preventing tool calls from appearing stuck). Extract shared command-allowlist logic to runtime package for reuse.
- a6b06b2: Three adapter infrastructure fixes:
  1. Codex model list expanded from 8 to ~40 models — covers GPT-5 family
     (5/5.1/5.2/5.4/5.5), GPT-5.6 (luna/sol/terra), GPT-4.1/4o, and
     o-series reasoning models (o1/o3/o4-mini).
  2. CLI `agentproto install <slug>` now drives a generic ACP agent's
     `install_hint` through the shared hint parser (new `install-hint.ts`
     module, extracted from `install-driver.ts` to break a circular dep).
     The `vendored` install step checks if the binary is already on PATH,
     runs npm/uv/pip/brew/cargo/go hints when recognized, and fails loud
     with an actionable message otherwise.
  3. `binOnPath` in `acp-generic.ts` now checks well-known package-manager
     install directories (`~/.local/bin`, `~/.cargo/bin`, `~/go/bin`,
     `/opt/homebrew/bin`, `/usr/local/bin`) as a fallback when PATH hasn't
     picked them up yet — fixes adapters installed via `uv tool install`
     not showing as "available" until the daemon restarts.

  Also: modelDerivedApiKey provider resolution for adapters like mastra-agent.

- 1523879: Improve error messages in ACP error responses by extracting nested error causes, handling generic error messages, and appending stack frames for traceability.
- 89d5102: Fix a timing race condition in MastraAcpAgent.prompt() where Session.sendMessage may resolve before agent_end events are emitted on follow-up turns. The fix keeps the event subscription alive by waiting for agent_end explicitly, ensuring all events are captured.
- bd5faae: Fix Anthropic API crashes on trailing reasoning blocks by wiring ProviderHistoryCompat input processor to strip reasoning-type content from assistant messages before sending to the model provider.
- Updated dependencies [996ec8e]
- Updated dependencies [c17620e]
- Updated dependencies [33e97d3]
- Updated dependencies [d22fec5]
- Updated dependencies [af936f8]
- Updated dependencies [59bc722]
- Updated dependencies [337cbfd]
- Updated dependencies [ec9efa3]
- Updated dependencies [b51b58e]
- Updated dependencies [2375019]
- Updated dependencies [6fba2b9]
- Updated dependencies [bf3407e]
- Updated dependencies [82ca9e6]
- Updated dependencies [c1e1807]
- Updated dependencies [2c24d6f]
- Updated dependencies [ce6352b]
- Updated dependencies [57dec3b]
- Updated dependencies [1cb2093]
- Updated dependencies [a6b06b2]
- Updated dependencies [be06061]
- Updated dependencies [bd990d1]
- Updated dependencies [dde641e]
- Updated dependencies [66a6446]
- Updated dependencies [4b20f1e]
- Updated dependencies [bd5faae]
- Updated dependencies [c3dbdc4]
- Updated dependencies [435a6f2]
- Updated dependencies [b5ec52b]
- Updated dependencies [41e36f4]
- Updated dependencies [9d76f08]
- Updated dependencies [16e4304]
- Updated dependencies [16e4304]
  - @agentproto/runtime@2.6.0
  - @agentproto/driver-agent-cli@2.2.2
  - @agentproto/mastra@0.2.7

## 0.4.2

### Patch Changes

- e68c999: Weekly minor/patch dependency bump (w33). Fixes `TUI` class → `TuiMainScreen` rename from `@earendil-works/pi-tui` 0.84.1.
- Updated dependencies [e68c999]
  - @agentproto/mastra@0.2.6

## 0.4.1

### Patch Changes

- Updated dependencies [08bcd4a]
  - @agentproto/driver-agent-cli@2.2.1

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
