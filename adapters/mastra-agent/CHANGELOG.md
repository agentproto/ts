# @agentproto/adapter-mastra-agent

## 0.7.0

### Minor Changes

- 0012980: feat(permissions): thread plan \_meta through the hold path and add free-text feedback on the respond path

  Adds `feedback?: string` to permission resolutions, enabling users to attach contextual information when approving or denying held tool-permission requests. The feature threads through all layers: types export `ACP_META_FEEDBACK` constant for the `_meta` key convention, ACP client carries `_meta` through to agent-prompt events, runtime forwards feedback on outcomes, and mastra-agent adapter folds feedback into suspension resumeData. CLI gains `--feedback` flag on approve/deny commands and renders plan text from suspension payloads. All changes are backward compatible.

### Patch Changes

- 5b30a74: Fix deadlock when a tool suspension (e.g. `submit_plan`) lacks an approval responder. Previously, follow-up prompts would be silently queued and never executed while the session appeared healthy. The fix rejects new prompts when a suspension is pending, provides visibility via notification messages, and properly cleans up suspension state after cancellation.
- Updated dependencies [a581e76]
- Updated dependencies [a939171]
- Updated dependencies [f9e21fd]
- Updated dependencies [dc7729b]
- Updated dependencies [2498d05]
- Updated dependencies [69a25bd]
- Updated dependencies [ee15252]
- Updated dependencies [672fc7c]
- Updated dependencies [0012980]
- Updated dependencies [5328e9b]
- Updated dependencies [f17e3a0]
- Updated dependencies [d315c0a]
- Updated dependencies [55c8154]
- Updated dependencies [a48dc03]
- Updated dependencies [db90fb3]
- Updated dependencies [d190202]
- Updated dependencies [f6593d4]
- Updated dependencies [49a89ba]
- Updated dependencies [aff7794]
- Updated dependencies [f75ef5d]
- Updated dependencies [3a928c1]
- Updated dependencies [9a489e7]
- Updated dependencies [ce273d2]
- Updated dependencies [c71753a]
- Updated dependencies [3a928c1]
- Updated dependencies [f295874]
- Updated dependencies [bf87d9e]
- Updated dependencies [a04bd29]
- Updated dependencies [fe9a374]
  - @agentproto/runtime@2.12.0
  - @agentproto/mastra@0.2.11
  - @agentproto/driver-agent-cli@2.4.1
  - @agentproto/agent@0.2.2

## 0.6.0

### Minor Changes

- dcb0bc5: P7 deliverables 1 & 2: Generic daemon MCP tool proxy and multi-adapter app_run support.

  Deliverable 1 closes the gap where app agents couldn't reach daemon tools outside a hand-curated set: a new daemon MCP tool proxy discovers and proxies any `tools/list`-exposed tool an AGENT.md declares, with automatic `appId` injection for `app_*` tools so models never need to know their own app id.

  Deliverable 2 extends `app_run` to support adapters that declare no `agent` option (claude-code, hermes, codex, ...): the spawn is now built FROM the AGENT.md (frontmatter model + body-as-prompt) instead of pointed at a path, with backward compatibility for mastra-agent (which still gets the path-based behavior).

### Patch Changes

- Updated dependencies [1541277]
- Updated dependencies [5171a24]
- Updated dependencies [8215419]
- Updated dependencies [e655351]
- Updated dependencies [dcb0bc5]
- Updated dependencies [2fc4c69]
  - @agentproto/runtime@2.11.0
  - @agentproto/mastra@0.2.10

## 0.5.5

### Patch Changes

- Updated dependencies [47653e3]
  - @agentproto/runtime@2.10.1

## 0.5.4

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

- Updated dependencies [7a96351]
- Updated dependencies [77ca7ff]
- Updated dependencies [dfda0b1]
- Updated dependencies [4fa1a02]
- Updated dependencies [f5b462a]
- Updated dependencies [f0c51a7]
- Updated dependencies [d663b35]
- Updated dependencies [12bb9e8]
- Updated dependencies [728205b]
  - @agentproto/runtime@2.10.0
  - @agentproto/driver-agent-cli@2.4.0
  - @agentproto/agent@0.2.2
  - @agentproto/mastra@0.2.9

## 0.5.3

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

- Updated dependencies [0097d36]
- Updated dependencies [dfb41f6]
- Updated dependencies [76f2c78]
- Updated dependencies [adebd5b]
- Updated dependencies [1297e7f]
- Updated dependencies [64088e0]
- Updated dependencies [e3ad769]
- Updated dependencies [4ac9d37]
- Updated dependencies [88134e9]
- Updated dependencies [f62f63a]
- Updated dependencies [90411f9]
- Updated dependencies [557c4d0]
- Updated dependencies [007716f]
- Updated dependencies [c48c10d]
- Updated dependencies [34bbf65]
- Updated dependencies [c6b5e41]
- Updated dependencies [7d39ce7]
- Updated dependencies [d5eb115]
- Updated dependencies [f90a383]
- Updated dependencies [11982fd]
- Updated dependencies [e2314b3]
- Updated dependencies [8900417]
- Updated dependencies [9191286]
- Updated dependencies [dcfaa65]
- Updated dependencies [baf8570]
- Updated dependencies [7220068]
- Updated dependencies [bdc7d6f]
- Updated dependencies [6372c19]
- Updated dependencies [8a3d53d]
- Updated dependencies [c5016ed]
- Updated dependencies [9953527]
- Updated dependencies [b95e23b]
- Updated dependencies [1fd4a15]
  - @agentproto/runtime@2.9.0
  - @agentproto/driver-agent-cli@2.3.1
  - @agentproto/mastra@0.2.8

## 0.5.2

### Patch Changes

- Updated dependencies [afa1796]
- Updated dependencies [3740171]
- Updated dependencies [d63cd31]
- Updated dependencies [bfd7daf]
- Updated dependencies [1bb03c4]
- Updated dependencies [da57681]
- Updated dependencies [949c6c7]
- Updated dependencies [463d345]
- Updated dependencies [d1b4aa4]
  - @agentproto/runtime@2.8.0

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
