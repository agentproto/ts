# @agentproto/cli

## 0.16.0

### Minor Changes

- 9f584c4: Rename "plugins" to "adapters" in the CLI to free up "plugin" for Agent Plugins v1.0.0 standard. This is a breaking change: `agentproto plugins` → `agentproto adapters`, config key `plugins[]` → `adapters[]`, manifest schema `agentproto/plugin/v1` → `agentproto/adapter/v1`.

  Introduce `@agentproto/pack` (AIP-52 PACK.md reference implementation) and `@agentproto/plugin` (Agent Plugins v1.0.0 reference implementation) packages.

- 4c44c61: Add app install/list commands and --app flag to app serve

### Patch Changes

- 7a96351: Fix curation drift on `mode: "allow"` auth profiles: an allowlist generated once at create/import time was a frozen snapshot of the catalog that day — new models the catalog picked up later never became usable through the profile, and retired ones lingered forever, with nothing surfacing the mismatch. Adds an explicit, opt-in re-sync: `refreshAuthProfileModels` (`@agentproto/auth`) recomputes a profile's `ids` against a caller-supplied current-catalog snapshot, exposed as the `auth_profile_refresh_models` MCP tool and the `agentproto auth profile refresh-models <id>` CLI verb. Nothing calls this automatically — a profile is only touched when refreshed by name — and it rejects a `mode: "all"` profile outright, since that mode already tracks the live catalog on every read.
- f5b462a: Add test coverage for `auth profile refresh-models` CLI command and `auth_profile_refresh_models` MCP tool. Both test suites verify the happy path (successful refresh against the current model catalog) and error handling (unknown profile id).
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
- Updated dependencies [4b924c9]
- Updated dependencies [008a483]
- Updated dependencies [3496977]
- Updated dependencies [008a483]
- Updated dependencies [dfda0b1]
- Updated dependencies [f0c51a7]
- Updated dependencies [12bb9e8]
- Updated dependencies [001a2a0]
- Updated dependencies [5dcc733]
  - @agentproto/auth@1.0.1
  - @agentproto/model-catalog@0.9.0
  - @agentproto/driver-agent-cli@2.4.0
  - @agentproto/acp@0.7.3
  - @agentproto/driver@0.2.1
  - @agentproto/provider-kit@0.4.2
  - @agentproto/sandbox-e2b@0.3.6
  - @agentproto/secrets@0.2.4
  - @agentproto/worktree@0.5.4
  - @agentproto/runtime-profile-standard@0.1.2
  - @agentproto/sandbox-box@0.2.5

## 0.15.0

### Minor Changes

- fbdc28b: Centralize session watch keypress handling and add a `s` key to view a session's Story/conversation. Exposes new public helpers `isTerminalSession`, `sessionRowLabel`, `terminalKindMark`, `attachMode`, `decodeWatchKey`, and the `WatchKeyAction` type.
- 34bbf65: Extract release-check logic from VS Code into `@agentproto/runtime` for code sharing with the CLI. Add `daemon status` release indicator and VS Code update-prompt command with tarball/workspace-specific behaviors.
- d9aada2: Add CLI flags for agent spawn configuration: `--access-profile` (named billing profile), `--worktree`/`--no-worktree` (git worktree isolation), `--mode` (manifest-declared mode), and `--effort` (reasoning effort). Mirrors MCP agent_start tool fields. Includes actionable error handling for access profile failures.
- f90a383: Add queue management commands and MCP tools for prompt FIFO inspection and control.

  Introduces `agentproto sessions queue <id>` CLI command with flags `--force`, `--deliver`, `--drop` to inspect and manipulate queued prompts after enqueue. Adds four new MCP tools (`session_queue_list`, `session_queue_promote`, `session_queue_deliver`, `session_queue_drop`) with the same semantics. HTTP routes mirror the MCP surface.

  New public exports: `previewPrompt()`, `promptOriginLabel()`, `QueuedPromptView` interface from @agentproto/runtime for after-the-fact queue UI. Origin tracking distinguishes user-initiated queuing from agent/child-sourced prompts. Queue badge ("N queued") shown in CLI and VS Code session listings.

  All three operations are deliberately distinct: promote reorders without interrupting; deliver interrupts and dispatches immediately; drop removes without delivering.

- 85c0ad7: Add `--host` option and `ui.tools` allowlist enforcement to `agentproto app serve`. The `--host` option allows binding to addresses beyond loopback (default `127.0.0.1`), with a stderr warning when used. The `ui.tools` allowlist is read from APP.md frontmatter, providing a second layer of defense: when absent, all tools are allowed (backward compatible); when explicitly empty, all tools are blocked; otherwise, only listed tools are forwarded. The distinction between absent and empty allows apps to opt into explicit allowlisting while maintaining backward compatibility with apps predating this feature.

### Patch Changes

- 4ac9d37: Documentation sync: Update MCP tool naming conventions (resource_action pattern), version bumps (0.12.0 → 0.14.0), and add docs for new features (daemon status build identity, pack build subcommand, workspace-brain transcript chunking, ops-panel app).
- 11982fd: Introduce shared dashboard presence classifier (`presenceFor`) to unify session-status rendering across CLI and VS Code. Previously, the CLI sessions table and VS Code tree/webview each derived their own inconsistent status readings. The new four-state model (running/tending/attention/quiet) is driven by a pure, config-aware classifier in @agentproto/runtime, consumed identically by both clients. Fixes status divergence and adds grace-window config (`sessions.attentionDelaySec`, default 60s).
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

- 7220068: Fix "restart starts a terminal but it doesn't work" bug: add origin-gate that prevents agent-cli/ACP-origin sessions from defaulting to provider-native terminal restart. ACP-origin sessions now default to agent-level resume, with explicit opt-in via `preferNativeTerminal` flag. Implement billing-auth re-resolution for pty-native path to prevent ambient credential leaks, closing #824/#490 for this codepath.
- 6372c19: Implement exit-time auto-reclaim for policy-provisioned (implicit) worktrees. When a session spawned under the `"always"` isolation policy without an explicit `worktree` request exits cleanly (merged/fresh, no uncommitted work), its worktree is automatically reclaimed using the same safety-layered classify→re-verify→remove pipeline as `worktree gc`. Caller-explicit worktrees (today's manual-cleanup behavior) are never auto-reclaimed. The feature is fire-and-forget, best-effort only, and never interrupts session teardown.
- 8a3d53d: Fix two critical bugs in `monitorSessionWait`:
  1. **Stale fast-path**: The synchronous already-in-target-state check for `turn-end` now requires `opts.since !== undefined` to fire. Without a cursor anchor, there is no way to distinguish "the turn this wait is waiting for already finished" from "some turn finished hours ago". Fresh `agentproto sessions wait` CLI processes (which have no persisted cursor) now correctly fall through to the real bus-subscribe long-poll instead of instantly succeeding against stale history.
  2. **Dropped empty/reason fields**: `SessionTurnEndEvent.empty` (zero assistant output, zero tool calls) and `.reason` (e.g. `"error"`) are now propagated through all three branches of the wait monitor (ring-replay, sync fast-path, bus long-poll) so callers can distinguish productive turns from silent no-ops (bad auth/model config) or adapter-reported errors. CLI exit code 4 is added for these cases.

  Includes a new `currentEventsCursor()` method to capture race-free cursors for prompt+wait patterns that cannot otherwise subscribe before a turn completes.

- c5016ed: Fix critical production incident (2026-08-22) where running daemon sessions' own working directories were incorrectly deleted by worktree GC. Root cause: `computeLiveness` was defaulting to the frozen legacy sessions file instead of reading per-workspace bucket files (AIP-46). Also adds `protectedPaths` mechanism as belt-and-suspenders protection, wiring the daemon's live in-memory session registry to prevent TOCTOU races between plan and apply.
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

- Updated dependencies [95f7b5e]
- Updated dependencies [e826a4a]
- Updated dependencies [76f2c78]
- Updated dependencies [64088e0]
- Updated dependencies [e3ad769]
- Updated dependencies [e2314b3]
- Updated dependencies [baf8570]
- Updated dependencies [6372c19]
- Updated dependencies [8a3d53d]
- Updated dependencies [c5016ed]
- Updated dependencies [b95e23b]
- Updated dependencies [1fd4a15]
  - @agentproto/model-catalog@0.8.5
  - @agentproto/driver-agent-cli@2.3.1
  - @agentproto/secrets@0.2.3
  - @agentproto/acp@0.7.2
  - @agentproto/sandbox-e2b@0.3.5
  - @agentproto/worktree@0.5.3
  - @agentproto/sandbox-box@0.2.4

## 0.14.0

### Minor Changes

- 7c1d7f5: Add `agentproto pack build [dir]` command to centralize skill-pack build logic, eliminating per-package duplicate scripts. The command builds both a flat npm layout and a versioned bundle for the Anthropic consumer, with version sourced from the package's own package.json (aligned with changesets).
- da57681: Add build identity tracking to CLI and runtime. Captures git SHA and build timestamp at build time, and judges source (workspace vs published) at runtime. This enables operators to distinguish between workspace distributions and published tarballs of the same version via `daemon start`/`status` output and `/health` endpoint.

  New exports:
  - `renderBuild()` from `@agentproto/cli/commands/daemon`

  New optional fields:
  - `DaemonHealthInfo.build`
  - `CreateGatewayOptions.build`
  - `RuntimeHttpServerOptions.build`
  - `DaemonHealth.build` (VS Code)

### Patch Changes

- 8b75d61: Declare a model list on the kimi-cli generic-ACP spec (default kimi-k3 plus
  the moonshot allow-list) so its launch picker offers real models instead of
  only "custom".
- 7b28edf: Refresh the Mistral model catalog from the live /v1/models list (adds the
  medium tier, codestral, devstral, ministral, magistral; drops retired ids)
  and declare a model list on the mistral-vibe generic-ACP spec so its launch
  picker offers real models instead of only "custom".
- 99fb2fb: Accuracy pass on skill documentation and AGENTS.md. Fixes ~20 tool names in skill documentation to match current runtime API (agent*output, command_log_tail, file*\_, terminal\_\_, etc.). Corrects permissions_respond schema documentation. Removes diverged duplicate SKILL.md file from packages/cli/skill/ (never imported by code but shipped in npm tarball). Updates reference documentation paths and line numbers.
- 132ffe5: Documentation updates for CLI enhancements, adapter protocol changes, and provider preset expansion.
  - **@agentproto/adapter-jcode**: Updated protocol documentation to reflect NDJSON streaming support and added exit code semantics for setup requiring TTY (code 78).
  - **@agentproto/cli**: Documented new session commands (`prompt`, `pin`, `unpin`), daemon capabilities (PATH self-healing, version reporting in `/health`), file upload endpoint for `app serve`, and added grok-cli adapter reference.
  - **@agentproto/provider-presets**: Added documentation for new provider presets: OpenAI, Mistral, Groq, Nebius, Hugging Face, and DeepInfra.

- d1b4aa4: Fix phantom-PR regression where sessions at the repo root would incorrectly attribute open PRs that happen to be on the default branch. Add default-branch guard to `makeOpenPrResolver` and only record PRs when actually stamped for the first time, preventing misattribution on idempotent re-reads.
- Updated dependencies [7b28edf]
- Updated dependencies [e8d39e8]
  - @agentproto/model-catalog@0.8.4

## 0.13.0

### Minor Changes

- 2e24a7e: Enhance daemon lifecycle management with health reporting and shutdown statistics.

  **@agentproto/cli changes:**
  - New `runStop()` function exported for daemon stop command with pre-shutdown stats gathering
  - `runStart()` and `runRestart()` now accept optional `health: HealthFetchFn` and `probeAttempts` parameters for testability
  - New `DaemonHealthInfo` and `DaemonStopStats` interfaces enable rich metadata tracking
  - Lifecycle info blocks report daemon version, uptime, workspace, binary path, and activity metrics (sessions, token counts, spend estimates)
  - Enhanced `humaniseUptime()` to show nested units (e.g., `3h12m` instead of `3h`)
  - Added `formatDuration()` helper for shutdown messages

  **@agentproto/runtime changes:**
  - `/health` endpoint now reports daemon version, process ID, node executable path, and entry point
  - Added `startedAt` ISO timestamp to `/health` for debugging
  - These metadata fields enable lifecycle tooling to accurately report "what is actually running"

- c33e432: Add `@agentproto/app-client` — a typed client for the `window.McpApp` bridge with TanStack Query React hooks supporting host/bridge/standalone mode fallback.

  Add `create-agentproto-app` — a CLI scaffolder for new agentproto agent apps with Vite + React + TanStack Router/Query UI.

  Add `app build`, `app dev`, `app pack`, `app serve` CLI verbs to build, develop, package, and serve agent apps. Refactor `app-serve.ts` exports to share bridge logic with `app dev`.

- 6e9b67b: Add file upload endpoint (`/__agentproto/upload`) to `agentproto app serve`, enabling browser UIs to upload files to an `inbox/` directory. Exports new utility functions: `sanitizeUploadName()` for security-focused filename validation, `resolveInboxTarget()` for collision-resistant path resolution, and `UploadSizeTracker` class for enforcing 200 MB size limits.
- f3fa4e6: Add --template vanilla, stamp app-client version, honour ui.port in app dev
- 7083baa: Implement PATH self-healing for daemon start/restart. The daemon's plist now automatically refreshes its `EnvironmentVariables.PATH` on every `kickstart` by probing a login shell and rewriting the plist if the PATH changed, eliminating the need to manually re-run `daemon install` after installing new CLI tools (e.g., via `uv tool install`).
- cbe11c2: Fix jcode print arm: add `--ndjson` output format and move `run` subcommand to `bin_args` so composed flags land after it (not before). Add comprehensive jcode NDJSON event mapper with full test coverage. Implement fail-fast TTY handling for interactive setup steps: refuse pre-spawn when stdin is not a TTY, return distinct `EXIT_SETUP_NEEDS_TTY (78)` to surface the condition separately from real failures. Add `needsInteractiveSetup` flag to `AdapterInstallResult` and VS Code install action to offer "Open Setup Terminal" for TTY-blocked installs.
- d69e120: Add `agentproto sessions prompt` subcommand to message already-running sessions via the daemon's `POST /sessions/:id/prompt` endpoint. Supports fire-and-forget queuing (default), blocking mode (`--wait`), interrupt (`--interrupt`), and queue-jumping (`--force`).
- a0558d4: Add session pinning — a server-persisted, list-visibility-only favorite flag. Pinned sessions sort to the top of `agentproto sessions` table and the VS Code webview's dedicated "Pinned" group. Includes new CLI `pin`/`unpin` subcommands, the `session_set_pinned` MCP verb, HTTP route `POST /sessions/:id/pin`, and dedicated UI in VS Code. Deliberately orthogonal to `keepAlive`, reaper eligibility, and notifications — pin is a quiet, structural sort/display flag with zero operational side effects.
- 140874a: Add optional `provider` field to ACP agent specifications. This allows generic ACP adapters (Mistral Vibe, Google Gemini CLI, Moonshot Kimi CLI) to declare their billing endpoints, enabling clients to link the harness to that provider's wallets even when no model list is declared. The provider is projected through AdapterInfo and integrated into VSCode wallet linking logic.

### Patch Changes

- e418ec7: Documentation updates for new jcode adapter, MCP tool families, configuration enhancements, and Mastra adapter API changes.
- 8a05833: Add CORS header support to the app-serve tool-call bridge, enabling cross-origin requests from embedded viewers to reach the server.
- 27a22ca: Persistent per-session isolated adapter config directories to enable native resume after adapter respawns.

  Previously, the isolated `CLAUDE_CONFIG_DIR` was a throwaway mkdtemp recreated on every spawn. This meant the SDK's conversation store (projects/<cwd-slug>/<uuid>.jsonl) was lost on respawn, causing resumeSessionId to degrade to a digest fallback every time an adapter process was reaped and restarted.

  The fix introduces `SessionDescriptor.adapterConfigDir` to persist the config location across respawns, keyed by the first session id in a lineage (`~/.agentproto/adapter-config/<sessionId>`). The runtime threads this through all spawn paths (agent_start, session_restart, lazy resume, cron, judges, webhooks, workflow steps), and the driver preserves the SDK's own state when reusing a persistent dir while always re-asserting `mcpServers: {}` to prevent ambient leaks from mid-session `claude mcp add` commands.

  Backward compatible: legacy rows without the new field keep today's digest-fallback behavior.

- 446d313: Fix semantic accuracy of generic ACP agent status: report installed agents as 'ready' (bin on PATH, no setup/auth pending) instead of 'available' (which implies pending setup/auth). Eliminates UX bug where VS Code offered "Install" forever on already-installed CLIs.
- 100d074: Wire grok-cli adapter into the CLI package's static CATALOG and VS Code extension's icon mappings. The adapter was previously installable via `agentproto install` but invisible to adapter discovery UI (MCP adapter_list, VS Code Harnesses panel) because it was only found via workspace scan, not the bundled catalog. Adds catalog entry with xAI branding metadata, SVG icon, and adapter icon → file mapping for VS Code.
- a001a4f: Increase test timeout for all-adapters harness-capabilities test from vitest's 5s default to 30s. The test imports all installed adapters including heavy @mastra/core graph modules on a cold worker, causing it to exceed the default timeout under parallel test runs on loaded machines.
- Updated dependencies [27a22ca]
- Updated dependencies [ce7cbb7]
- Updated dependencies [cbe11c2]
  - @agentproto/driver-agent-cli@2.3.0

## 0.12.0

### Minor Changes

- b51b58e: **Support shell-based package managers (uv, pip, brew, cargo, go, pipx)** — expand adapter installation beyond npm to handle package managers commonly used in AI/ML workflows. New `parseShellHint` function parses and validates non-npm install commands; only recognized package managers are executed to prevent blind shell injection.

  **ACP adapters can now use `uv tool install`, `pip install`, etc.** — planner detects hint type (npm → shell → unsupported) and adapter install routes handle shell commands with the same safety/timeout guards as npm-global installs.

- 6fba2b9: Feature-flag the LLM Endpoint proxy sidecar behind `features.llmEndpoint` (default false). When disabled, the route is not registered, the registry is not created, and MCP tools are not exposed.
- 3d193b5: **`agentproto app pack/unpack`**: bundle and unbundle agentproto apps as self-contained `.agentapp` tar.gz archives with SHA-256 integrity verification.

  New subcommands:
  - `agentproto app pack <appDir> [--out <path.agentapp>] [--json]` — walks an app folder (must have `.agentproto/APP.md`), computes an aggregate SHA-256 over every file, writes a manifest.json, and tars the contents into a `.agentapp` bundle.
  - `agentproto app unpack <file.agentapp> [--dir <outDir>] [--json]` — extracts and verifies the bundle's SHA-256 before restoring, fails if corrupted.

  Bundles include the entire app tree (agents, workflows, optional UI, loose files). Extraction yields `manifest.json`, `.agentproto/`, and relative paths identical to the original—round-trip stable for `readAppRefs` / `app_install`.

- 3d54f15: Add `agentproto app serve` command for serving app UIs as standalone webapps with MCP connectivity. Introduces optional `ui.port` field to AppUiDefinition, implements a static HTTP server with bridge script injection, and establishes MCP client proxying through a reserved `/__agentproto/tool-call` endpoint.

### Patch Changes

- bf3407e: Fix unhandled ChildProcess 'error' events that crash the daemon on spawn failures (e.g., bad binary, missing PATH entry). Resolve "node" binary to process.execPath to sidestep PATH lookup issues in minimal launchd environments. Convert spawn errors to rejected promises instead of unhandled exceptions.
- 82ca9e6: Fix daemon crash from unhandled spawn errors and PATH-based node resolution issues:
  - Add error event listeners to spawn processes to prevent unhandled exceptions from crashing the daemon
  - Resolve `bin: "node"` in agent CLI definitions to `process.execPath` instead of relying on PATH lookup, preventing failures in launchd environments with minimal PATH
  - Fix auth method availability detection for models with `modelDerivedApiKey` by checking both `authSubscription` and `modelDerivedApiKey` for oauth-bearer eligibility
  - Improve test mocks to properly emit spawn events, enabling proper coverage of spawn failure scenarios

- 5798b49: Add AIP-45 adapter for 1jehuang/jcode — a RAM-efficient Rust coding agent with semantic memory, multi-agent swarm coordination, and multi-provider support (Claude, OpenAI, Gemini, OpenRouter, DeepSeek, Groq, Mistral, Ollama).

  Adapter uses `print` protocol (headless mode): spawns `jcode run "<prompt>"` per turn and captures stdout. No ACP mode is currently documented; swarm coordination not yet wired.

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

- 54d9620: Add workspace-local adapter resolution as a fallback when npm/node_modules resolution fails. Enables adapters under active development to resolve from `adapters/<slug>/dist/index.mjs` before they're added as dependencies or published to npm, improving the adapter authoring workflow.
- 873e10a: Reload newly installed CLI adapters during first-run bootstrap instead of requiring a second invocation.
- Updated dependencies [415044d]
- Updated dependencies [5f5b1bc]
- Updated dependencies [6e403f8]
- Updated dependencies [bf3407e]
- Updated dependencies [82ca9e6]
- Updated dependencies [c4ca23a]
- Updated dependencies [b5ec52b]
  - @agentproto/model-catalog@0.8.3
  - @agentproto/worktree@0.5.2
  - @agentproto/sandbox-e2b@0.3.4
  - @agentproto/driver-agent-cli@2.2.2
  - @agentproto/acp@0.7.1
  - @agentproto/sandbox-box@0.2.3

## 0.11.5

### Patch Changes

- e68c999: Weekly minor/patch dependency bump (w33). Fixes `TUI` class → `TuiMainScreen` rename from `@earendil-works/pi-tui` 0.84.1.
- 69e97d9: Documentation sync: version bumps, turn-liveness watchdog config details, UI surfaces/artifacts/dev-launch config examples, and agentproto-apps-sync binary documentation.
- Updated dependencies [2b58616]
- Updated dependencies [e68c999]
- Updated dependencies [6e1fcf3]
  - @agentproto/model-catalog@0.8.2
  - @agentproto/rendezvous@0.2.2
  - @agentproto/sandbox-e2b@0.3.3

## 0.11.4

### Patch Changes

- c58b9fe: Implement turn-liveness watchdog: detect mid-turn agent-cli sessions with dead adapter streams.

  The daemon periodically sweeps every BUSY agent-cli session and, for one that is mid-turn, NOT legitimately blockedOn a subagent/command, and has had no adapter activity for longer than the configured threshold (default: 5 minutes), stamps `stalledSinceMs` on the descriptor and emits `session:stalled` — surfacing a dead adapter stream (network drop, hung child) that would otherwise sit indistinguishable from healthy long work. Detection and observability only; never auto-kills or restarts. Threshold configurable via `daemon.turnStallAfterMs` config or `AGENTPROTO_TURN_STALL_AFTER_MS` env var (DEFAULT ON, opt-in-to-disable). VS Code displays the stall flag (⚠ badge) when the daemon confirms, with a tooltip showing the silent duration.

## 0.11.3

### Patch Changes

- 671b628: Fix daemon adapter installs: strip the "install" verb before passing args to runInstall, and add --allow-unverified flag to allow TTY-less daemon/UI installs of catalog adapters.
- Updated dependencies [08bcd4a]
  - @agentproto/driver-agent-cli@2.2.1

## 0.11.2

### Patch Changes

- 4b6bbe6: Documentation sync: update version to 0.11.1-alpha and document new spawn policies (dedupe/attach), judge gate structured verdicts, implicit session deduplication, and worktree async provisioning.
- 63b97e5: Enhance CLI daemon discovery documentation with comprehensive explanation of the layered fallback strategy (env override → home runtime.json → central registry → workspace runtime.json), PID liveness checks for stale file detection, and known limitation regarding restart handoff windows. Updates help text in `browser`, `presets`, `sessions`, and `tunnel` commands to reference the full discovery order.
- 3e187e5: Add Google Antigravity adapter and extend print-arm event mapper.
  - **New adapter: @agentproto/adapter-antigravity** — AIP-45 print/headless adapter for Google Antigravity's `agy` CLI (a multi-model coding agent supporting Gemini, Claude, GPT-OSS). Includes auth documentation (OS keyring + Google Sign-In), sandbox policy, and model/option configuration.
  - **Print-arm event mapper extension** — Added `antigravity-stream-json` event schema handler to support `agy`'s custom wire-event taxonomy (discriminated by `event` field, nested `conversation_id`, incremental `text_delta` fragments). The mapper handles text streaming, tool calls, tool errors, usage tracking, and session resumption via `--conversation <id>`. Supports single wire lines that fan out to multiple StreamEvents (e.g., a tool step's terminal DONE carries both call and result).
  - **Type safety** — Introduced `PrintEventSchema` type to union all supported event taxonomies; updated Zod schema validation to include `antigravity-stream-json`.
  - **Catalog entries** — Added antigravity to the CLI adapter catalog; also included two new ACP generic agents (Mistral Vibe, Kimi CLI) with their VS Code lettermark overrides.

- 865e84a: Add @ast-grep/napi native dependency and externalize it from the tsup bundle to prevent platform-specific .node binding resolution conflicts.
- Updated dependencies [4b6bbe6]
- Updated dependencies [3e187e5]
- Updated dependencies [492240c]
  - @agentproto/model-catalog@0.8.1
  - @agentproto/worktree@0.5.1
  - @agentproto/driver-agent-cli@2.2.0
  - @agentproto/sandbox-box@0.2.2
  - @agentproto/sandbox-e2b@0.3.2

## 0.11.1

### Patch Changes

- 832870d: Documentation sync: daemon restart command, sessions gc garbage collection, install --allow-unverified flag, Gemini adapter shipped, pi adapter support, xai-anthropic and llm-endpoint provider presets, and launchd crash-only KeepAlive behavior.
- c1399f3: Weekly dependency update: bump @modelcontextprotocol/sdk, @mastra/core and ecosystem packages, turbo, tsx, and React types to latest patch/minor versions within semver constraints.
- 8228d88: Add dep-bump reclaim exemption for worktree GC: safely promote clean, unpushed worktrees from `hold` to `reclaim` when all commits are mechanical dependency bumps (subject and cumulative diff validation). Addresses storage bloat from recurring automated dependency-bump worktrees piling up as permanent holds. Includes comprehensive test coverage and applies re-validation at apply time (layer 2).
- 678bc1a: Session identity environment variables: inject `AGENTPROTO_SESSION_ID` and `AGENTPROTO_WORKSPACE_SLUG` into every process spawned by the daemon on a session's behalf (agent adapters, terminals, commands, cron jobs). Each spawn gets its own freshly minted id; the variables are set last to prevent caller forgery. This enables spawned processes to report back session context, tag telemetry, and nest child sessions under parent sessions via `parentSessionId`.
- Updated dependencies [c825a12]
- Updated dependencies [c1399f3]
- Updated dependencies [8228d88]
- Updated dependencies [980276e]
- Updated dependencies [fd3e287]
  - @agentproto/model-catalog@0.8.0
  - @agentproto/provider-kit@0.4.1
  - @agentproto/sandbox-e2b@0.3.1
  - @agentproto/worktree@0.5.0
  - @agentproto/sandbox-box@0.2.1

## 0.11.0

### Minor Changes

- 6a0a60c: add daemon PR-provenance reconciler and open-PR resolver
- 8367648: rename auth 'vendor' axis to 'endpoint' in profiles and manifests. The v1
  `~/.agentproto/auth-profiles.json` disk format deliberately keeps `vendor` for
  backward compatibility; the public TypeScript API exposes only `endpoint`.
- dc5e27a: support saving adapter-native posture modes with `agentproto preset add --mode-id`
- 831d4f5: Implement route-selection axis for AIP-45 launch-menu drill-down (WP1): add declarative `routeSelection` field to adapter manifests (distinguishes "free" vs. "derived-from-model"), project it through resolve/runtime layers, enrich catalog with per-route `multiModel` flags and flat routes index for tier-pinning logic.
- 61b23e0: Implement adapter installation API for harnesses: add `POST /adapters/:slug/install` HTTP route and `adapter_install` MCP tool to install not-yet-ready agent CLI adapters. Supports both acp-catalog CLIs (npm-global) and first-party workspace adapters (manifest install pipeline). VS Code extension UI integration with context-aware install button for installable harnesses.
- 23a6098: Add `--allow-unverified` flag to `agentproto install` to opt-in to running unverified curl/download installers. In non-interactive contexts (agents, daemon, CI), unverified installers are refused by default as a supply-chain attack mitigation; the flag explicitly bypasses this gate. Interactive (TTY) users proceed with a warning to preserve dev UX. Implements AIP-29 § Install methods compliance. New `shouldRefuseUnverifiedInstaller` policy function exported and unit-tested.
- 5ba2032: Add rawInput field propagation through permission-hold system. The tool call's raw input (e.g. Bash command string) now flows from requestPermission RPC → agent-prompt event → PendingPermission object → HTTP/MCP APIs, surfacing in the CLI `permissions ls` table as a truncated preview for enhanced transparency in permission request review.
- 3c0ef25: Add git-worktree garbage collection surface: `POST /worktrees/gc` HTTP route and `worktree_gc` MCP tool powering the daemon's worktree management. Defaults to dry-run mode; requires explicit `apply: true` to execute. Design maintains architectural isolation from `@agentproto/worktree` via an injected runner port, mirroring the `worktree_status` pattern.
- 17b503a: Harden daemon lifecycle for idempotent startup under launchd supervision:
  - **KeepAlive crash-only restart**: Changed plist `KeepAlive` from always-restart (`<true/>`) to crash-only (`<dict><SuccessfulExit>false</SuccessfulExit></dict>`). This allows clean exit-0 to stay settled, enabling idempotent `serve` startup when a healthy daemon already owns the port.
  - **Split `daemon start` into idempotent-launch vs force-cycle**:
    - `agentproto daemon start` now uses `kickstart` (no `-k`): idempotent, leaves a healthy daemon running.
    - `agentproto daemon restart` uses `kickstart -k`: force-cycle, kills and relaunches (replaces `pnpm killport 18790`).
  - **Idempotent gateway boot**: `serve` now preflights the `/health` endpoint before binding. If a healthy daemon already owns the port, exits cleanly with exit-0. If bind races, re-probes on EADDRINUSE and defers to the winner.
  - **Rate-limited reconnect logging**: New `createReconnectLogGate` (exported from `@agentproto/runtime`) rate-limits failure logging per key. A dead peer's standing reconnect loop logs the first failure immediately, then at most one line per window with a suppressed-count suffix. Fixes log spam: one dead pairing previously buried 85% of `daemon.log`.
  - **Test coverage**: New comprehensive tests for daemon lifecycle (`daemon-lifecycle.test.ts`), idempotent boot (`serve-idempotent-boot.test.ts`), and log rate-limiting (`reconnect-log-gate.test.ts`).

- 242df33: Add `agentproto sessions gc` CLI command and `POST /sessions/gc` HTTP endpoint for bulk garbage collection of terminal-status sessions. Supports `--older-than-days` (cutoff filter), `--forget` (permanent deletion vs. reversible archival), and `--json` (scripting output).
- babc42d: Add usage rollup feature for tracking spend estimates over rolling windows.
  - New `usage_rollup` MCP tool and `GET /usage/rollup` REST route for querying spend by profile, model, and harness
  - New CLI command `agentproto usage rollup` for local-derived, provider-agnostic spend estimates
  - Pure rollup logic (`parseWindow`, `rollupUsage`) correctly handles cumulative snapshots and separates priced vs unpriced tokens
  - Supports both shorthand (`5h`, `7d`) and ISO-8601 duration formats (`P7D`, `PT5H`)

- 0b87c92: Add skill pack fetch from npm and github. `agentproto install skill/<name>` now fetches the published pack when nothing is on disk, resolving out-of-the-box with no `--pack` required. Adds `--refresh` flag to bypass cache. New exports: `parsePackSpec`, `fetchNpmPack`, `fetchGithubPack`, `fetchPack`, `PackSpec` type, `FetchOpts` and `ResolvePackOpts` interfaces. Extended `resolveSkillPackDir(pack?, { allowFetch?, refresh? })` with optional opts parameter (backwards compatible).
- f3b54ad: Implement harness capability discovery — a new layer that answers "what can this adapter actually DO on this host right now" by discovering credentials, providers, model-discovery mechanisms, endpoint compatibility, and application contracts at runtime. Each adapter optionally exports a `<camelSlug>Capabilities` strategy that parses its native config/creds stores (e.g., `~/.gemini/settings.json`, `~/.hermes/auth.json`) to report live state. Falls back gracefully to a pure manifest projection when no strategy is available or it throws. Never surfaces raw credential values — only presence, fingerprints, and last-4 chars. Exposed via the new `harness_capabilities` MCP tool and `@agentproto/cli`'s `listHarnessCapabilities` function.
- 15abbee: Add `--keep-alive` flag to `agentproto sandbox attach` for always-on rendezvous model. Keeps sandboxes indefinitely awake using provider-specific mechanisms (e.g., Box's `ttlSeconds: null` no-auto-stop) instead of letting the provider's idle/TTL auto-stop reclaim them.
- 329ef7a: add PR settlement port to resolve pr activities via forge state

### Patch Changes

- c736c02: Dissociate auth profiles from routers/gateways and harness adapters. Session descriptors now carry explicit `harness`, `model`, `route`, and `accessProfile` identity. Runtime resolver derives api-key auth from the model and gateway route, injecting `base_url` + credential env without adapter hard-coding. Add native Moonshot support to `pi`, decouple `claude-sdk` from hard-coded gateway modes, and register a local `llm-endpoint` preset.
- c064bc7: migrate Codex adapter to @agentclientprotocol/codex-acp bridge
- d10ed02: Add worktree-status query surface (MCP tool + HTTP route). Exposes git worktree status with live PR integration and session linkage via `worktree_status` MCP tool and `GET /worktrees` HTTP endpoint. The heavy join lives in `@agentproto/worktree` and is injected at the daemon's composition root, keeping the runtime free of that dependency.
- f6943f0: MCP bridge now auto-stamps the origin of `agent_start` calls from the client's announced name (`clientInfo.name` from the MCP `initialize` handshake). This enables bridge-routed hosts to appear as source nodes in the session tree with zero caller cooperation, resolving the "honest ceiling" described in #575. Only touches session-creating tools and never overrides explicitly-set origins.
- e44385b: Stamp origin field on spawns from CLI, cron scheduler, and webhook/inbound watcher to track source channel and improve session lineage visibility. Extends the origin-tracking feature introduced in PR #575.
- c292790: Fix: `agentproto sessions start` now defaults working directory to the shell's current directory instead of silently using the daemon's active workspace. Aligns with standard CLI behavior (like git/npm). An explicit `--workspace` still lets the daemon resolve its own cwd; `--cwd` takes precedence over shell default.
- 139d18b: Fix daemon discovery priority and honor explicit ~/.agentproto/runtime.json pins.

  The resolver now checks ~/.agentproto/runtime.json early (if present and live), allowing users to explicitly pin a daemon endpoint. When reading the registry, it prefers entries matching config.json's declared daemon port over transient entries, fixing the issue where short-lived ephemeral daemons would hijack every CLI call away from the long-running declared serve daemon.

- 392021a: Add config-file surface and `agent_start` MCP exposure for adapter-spawn command sandboxing (PR 6b continuation):
  - **Config-file surface**: New `.agentproto/command-sandbox.json` `adapterSpawn` key (distinct from `command_execute`'s top-level `mode`) with separate env-var escape hatch (`AGENTPROTO_ADAPTER_COMMAND_SANDBOX_MODE`) to control adapter-spawn confinement persistently, justifying explicit opt-in due to larger blast radius.
  - **MCP exposure**: `commandSandbox?: "off" | "workspace" | "strict"` added to `agent_start` schema; forwarded through runtime and driver layers.
  - **Bug fix**: `serve.ts` was silently dropping `commandSandbox` from the opts destructure; fixed by including it in the spread and adding the type to `AgentAdapterResolver.startSession`.
  - **Credential access gap** (PR 6a follow-up): Added read-only paths to adapter-spawn defaults (`~/.gitconfig`, `~/.config/git`, `~/.config/gh`, `~/Library/Keychains`) fixing `git ls-remote` and `gh auth status` failures under `workspace` mode confinement.
  - **Async change**: `wrapAgentCliSpawn()` now async to support config-file loading; all callers updated.

  Backwards compatible: default behavior unchanged when no config and no explicit mode.

- 9b1736d: Add opt-in eager resume-on-boot for session survivability (PR-4). After a daemon restart, eligible agent-cli sessions are eagerly re-spawned without waiting for a prompt, restoring liveness to orchestrated fleets and completion policies. Feature is off by default (set `daemon.resumeSessionsOnBoot: true` to enable) and includes proper concurrency control and cross-process safety for multi-daemon deployments.
- 47dae30: Implement idle agent-session reaper (PR-6): periodically retire long-idle agent-cli sessions to free adapter processes and prevent resume-storms on daemon restart. New public API exports `runIdleReapPass`, `IdleReapSummary`, and `IdleReaperRegistry` for library users; opt-in via `daemon.idleReapAfterMs` config field or `AGENTPROTO_IDLE_REAP_AFTER_MS` env var.
- 7465b6c: Harden git-spawn PATH and worktree-cwd anchoring to fix two runtime bugs surfaced by worktree-gc daemon cron. Narrow inherited PATH (frozen at daemon install time) is merged with standard system bin dirs to prevent spawned tools like git from ENOENT-ing. Worktree-specific git spawns are anchored to stable repoRoot instead of per-worktree paths to prevent TOCTOU race conditions where concurrent gc reaps cause misleading "spawn git ENOENT" errors.
- fe77c62: Isolate machine-global test state to prevent race conditions when parallel worktrees run test suites concurrently. Replaces `Date.now()`-based temp directory naming and fixed port ranges with kernel-guaranteed unique resources (`mkdtemp` for directories, ephemeral ports for networking).
- 2ef3bd1: Add native `@agentproto/adapter-gemini` AIP-45 adapter for Google's Gemini CLI in ACP mode, with file-based subscription auth ("use my existing Gemini login" via ~/.gemini/oauth_creds.json). Includes comprehensive spawn and auth resolution tests, VSCode profile flow integration, and catalog entry.
- 4e8640f: Implement restart-scheduler (PR-2 of crash-detect chantier): opt-in automatic restart for agent sessions that crash unexpectedly. Introduces RestartPolicy per-session configuration with exponential backoff and rolling-window crash-loop cap. Event-driven scheduling evaluates policy on session:exited; periodic sweep executes due restarts via in-place resume. Persists state so daemon restart mid-backoff preserves schedule. Includes comprehensive test suite and proper lifecycle integration.
- d1ae65c: Refactor GitHub pack source from codeload tarball (source code) to GitHub Release asset (built pack). Changes fetch grammar from `github:owner/repo#ref` to `github:owner/repo[@version]`, targeting per-package release artifacts instead of arbitrary repo commits. Aligns with CI publishing strategy.
- e81ad25: Add `agentproto sandbox attach` — Phase 1 of AIP-36 sandbox reconnect. New CLI verb and runtime primitives (`attachSandbox`, `buildMcpConfigSnippet`, `registerSandboxAttachTool`) for connecting to already-existing sandboxes without tearing them down. Returns durable, token-gated connection descriptors for any MCP client to use directly. Extends `SandboxProvider` with optional `connect()` method for resume-after-pause workflows, and adds token capture from Box's `--private` and e2b's traffic restriction.
- 40d6a42: Implement resume-honesty fix (AIP-45 resumable capability): prevent silently presenting blank sessions as continuations. When adapters declare `capabilities.resumable: false` (e.g. hermes, mastra-agent), the restart path now gates all ACP-level resume attempts, substituting honest "fresh — resume not supported by X" labels and emitting `contextRestored: false` event flags. Lazy-revived unresumable sessions now get clear banners to prevent confusion with actual continuity.
- 42f1217: Fix routing and credential injection for gateway-routed adapters (D1-D5)
  - D1: Base URL injection gate — skip gateway baseUrl for derived-from-model adapters (hermes); fail loud when adapter can neither accept baseUrl nor derive its route
  - D2: Wire model form — generalized stripFixedNativeVendor for fixed-provider adapters (codex/openai, codex/gpt-5 not openai/gpt-5)
  - D3: Model-derived provider precedence — adapter-declared modelProviders wins over global catalog routing (pi bills kimi via moonshot, not openrouter)
  - D4: Gateway credential injection — resolveAuthSpec honors adapter-declared gatewayAuth.setEnv instead of preset keyEnv (claude-sdk reads ANTHROPIC_AUTH_TOKEN, not OPENROUTER_API_KEY)
  - D5: LLM endpoint adoption — status report never contradicts (running:false, healthy:true); adopt external healthy endpoints as owner:external with probed model list

  New exports: LlmEndpointStatusReport, stripFixedNativeVendor, routeSelection in AgentAdapterResolver.

- 4bdea9f: Add per-model provider and adapter-level route selection to support free-routing adapters. This enables adapters like claude-sdk to offer models across multiple billing gateways while preserving money-safety for fixed-provider and derived-from-model adapters. Includes catalog widening logic to emit gateway routes only for adapters that can reach them, plus UI fanout for independent route choice on launch-menu drill-down.
- 29042ca: Generate OpenCode model menu from shared provider catalog; add model-derived API key auth support and router-prefixed model ID handling across runtime and VS Code configuration UI.
- c064bc7: Migrate Codex adapter to maintained `@agentclientprotocol/codex-acp` bridge: removed fixed model defaults, switched model delivery from CLI args to ACP session config, changed model option from enum to dynamic string type. Simplified runtime to treat Codex generically (no special auth-awareness); removed `detectCodexAuthMode()` and related detection logic. Updated all test fixtures and documentation references.
- 04aedad: Weekly dependency bump with semver-safe minor/patch updates across 18 packages. Includes Mastra ecosystem update (1.31-1.48.x → 1.52.1), Claude SDK patch (0.3.200 → 0.3.220), build tool updates (turbo, tsx), and general dependency maintenance (yaml, ws, react, etc.). All changes verified to pass build, test, and type checks.
- 4832ced: Terminal restart fidelity: route-aware launch config, native terminal resume capability, and resume honesty.
  - Extracts `buildRouteAwareLaunchConfig` so fresh spawn and restart inject `base_url` identically; derived-from-model adapters (e.g. hermes) no longer receive an unsupported `options.base_url`.
  - Adds `capabilities.nativeTerminalResume` to the agent-cli manifest schema and stamps it on session descriptors; `pty-native` restart is now an explicit capability, not implied by ACP resumability.
  - Preserves auth profile, route, model, posture, effort, and effective environment across restarts; wire model strips catalog `@route` suffixes and fixed-provider native vendor prefixes.
  - Resume-honesty fix: adapters declaring `resumable: false` degrade to a flagged fresh spawn instead of a phantom ACP resume.

- Updated dependencies [c736c02]
- Updated dependencies [8367648]
- Updated dependencies [013e7b3]
- Updated dependencies [7192faf]
- Updated dependencies [8367648]
- Updated dependencies [93e6309]
- Updated dependencies [6c35cb9]
- Updated dependencies [831d4f5]
- Updated dependencies [6ff42b4]
- Updated dependencies [645279d]
- Updated dependencies [5ba2032]
- Updated dependencies [c506d87]
- Updated dependencies [41cd652]
- Updated dependencies [392021a]
- Updated dependencies [7465b6c]
- Updated dependencies [3865de6]
- Updated dependencies [4d200a9]
- Updated dependencies [f3f5e82]
- Updated dependencies [5643cb6]
- Updated dependencies [23fa73e]
- Updated dependencies [655b4b6]
- Updated dependencies [358af0e]
- Updated dependencies [f1484a4]
- Updated dependencies [0f10338]
- Updated dependencies [9de8157]
- Updated dependencies [f3b54ad]
- Updated dependencies [e81ad25]
- Updated dependencies [7f42bc2]
- Updated dependencies [15abbee]
- Updated dependencies [ec5f64f]
- Updated dependencies [1ea7682]
- Updated dependencies [42f1217]
- Updated dependencies [4542ca3]
- Updated dependencies [cce3546]
- Updated dependencies [c064bc7]
- Updated dependencies [04aedad]
- Updated dependencies [4832ced]
- Updated dependencies [b3e1648]
- Updated dependencies [5615d80]
  - @agentproto/driver-agent-cli@2.1.0
  - @agentproto/sandbox-box@0.2.0
  - @agentproto/worktree@0.4.3
  - @agentproto/auth@1.0.0
  - @agentproto/sandbox-e2b@0.3.0
  - @agentproto/driver@0.2.0
  - @agentproto/acp@0.7.0
  - @agentproto/model-catalog@0.7.0
  - @agentproto/provider-kit@0.4.0
  - @agentproto/rendezvous@0.2.1
  - @agentproto/secrets@0.2.2
  - @agentproto/runtime-profile-standard@0.1.2

## 0.10.0

### Minor Changes

- 4632ec7: Session management feature set: terminal input routing via POST /sessions/:id/terminal/input, session renaming via PATCH /sessions/:id and session_rename MCP tool, explicit --title flag for spawn, and structured↔terminal view toggle for dual-representation sessions. Includes code-point-aware name truncation, field-independent rename operations, and comprehensive test coverage.

### Patch Changes

- f3137e3: raise timeouts on slow cli tests
- Updated dependencies [8e44bce]
- Updated dependencies [a0b94fd]
- Updated dependencies [cc00682]
  - @agentproto/sandbox-e2b@0.2.1
  - @agentproto/auth@0.2.0
  - @agentproto/driver-agent-cli@2.0.1
  - @agentproto/secrets@0.2.1
  - @agentproto/acp@0.6.0

## 0.9.0

### Minor Changes

- cc84da6: Fix claude-code project-slug encoding and add persisted conversation index + `conversation locate` verb
- b331539: Add read-only GET /catalog/models + catalog_models MCP tool (SPEC §5)

### Patch Changes

- 5c99163: Sync docs (README/manifests) with already-shipped requesty preset, catalog-sync, and permissions watch
- 57d1499: Route sandboxed agent-step spawns through spawnAgentSession; e2b installPackages boot option
- Updated dependencies [9e30ad2]
- Updated dependencies [1411e36]
- Updated dependencies [b16bb83]
- Updated dependencies [a021138]
- Updated dependencies [9fab1ad]
- Updated dependencies [92c1c51]
- Updated dependencies [57d1499]
- Updated dependencies [48c55d5]
- Updated dependencies [3d403d7]
  - @agentproto/model-catalog@0.6.0
  - @agentproto/driver-agent-cli@2.0.0
  - @agentproto/acp@0.6.0
  - @agentproto/sandbox-e2b@0.2.0
  - @agentproto/worktree@0.4.2

## 0.8.0

### Minor Changes

- c271e80: Add skill-pack packages and extract shared zip helper with path fix
- a4d091d: Add policy-driven git-worktree isolation on agent_start
- d717e01: Add `permissions watch` — rule-based auto-resolution of held permission requests

### Patch Changes

- f392877: Sync docs with latest release features (interrupt, conversation_read, WORKTREE column, llm:context-windows, duration flags)
- 719771e: Inject provider-key env aliases (google → GOOGLE_API_KEY) at serve boot
- 2f8ba2d: Stop misdirecting zero-credential agent-cli users to buy a subscription
- Updated dependencies [dd3386d]
- Updated dependencies [719771e]
- Updated dependencies [a116fd6]
- Updated dependencies [9c2cec0]
- Updated dependencies [2f8ba2d]
- Updated dependencies [68d3093]
  - @agentproto/driver-agent-cli@1.2.0
  - @agentproto/model-catalog@0.5.0
  - @agentproto/worktree@0.4.1
  - @agentproto/provider-kit@0.3.0

## 0.7.0

### Minor Changes

- 9cec8c5: Add structured models.allowed entries to fix gateway model mode binding in VS Code picker
- 7b80d00: Add last-known-good fallback so a rebuilding adapter isn't reported as uninstalled
- e5d55a7: Record worktreePath and worktreeId on SessionDescriptor at spawn time
- 8778b9d: Add optional sessionId filter to policy_list, GET /policies, and policy ls

### Patch Changes

- b63bd5f: Backfill docs for release #289: policy/worktree verbs, config keys, sessions story
- 1dfba23: fix(cli): wrap --prompt string into a ContentBlock before calling session.send()
- 166b42c: Validate and echo resolved duration for all CLI timeout/interval flags
- a8be39e: Fix flaky CLI subprocess tests by adding explicit vitest timeouts
- 45ee7ef: Stop test gateways persisting fake session rows into the real ~/.agentproto/
- 9bae7bb: Fix node-pty spawn-helper exec bit + enrich PTY spawn error messages
- 97e08f0: give fan-out symlink-skip test the 15s timeout its siblings have
- d285a81: Fix install-skill test timeout: align vi.setConfig with runCli's 15s spawn budget
- Updated dependencies [b531fd1]
- Updated dependencies [9cec8c5]
- Updated dependencies [98bbebf]
- Updated dependencies [8d73291]
  - @agentproto/model-catalog@0.4.0
  - @agentproto/driver-agent-cli@1.1.0
  - @agentproto/worktree@0.4.0

## 0.6.0

### Minor Changes

- 1bdc055: Add xAI provider support and session options passthrough (base-url/auth-token/options-json)
- d62aca3: Add --model / --effort flags to `agentproto run`, with friendly unknown-flag error
- 7b6c8d0: Add daemon.authToken config field and --auth-token flag for persistent gateway bearer token
- be2842e: Add --output-schema flag to run for schema-validated JSON final output
- 5ae8c13: Add agentproto.json lifecycle: setup/teardown hooks, supervised services, localhost reverse proxy, and worktree CLI verb
- 049c2fe: Add generic ACP agent support: curated catalog, config-defined agents, acp verb
- 0ea6fc1: Add cross-session permission-hold inbox: permissions ls|approve|deny, MCP tools, REST routes
- 386a573: Add deterministic auth spawn mode (subscription vs api-key) for claude-code
- c036f59: Explicit credential selection + verifiable auth mode for claude-code spawns
- 60792f1: Add E2E daemon pairing: rendezvous broker, pair CLI, daemon registry
- 6894d2e: Add named terminal presets via terminalPresets in config.json
- 2bed7e6: Add worktree status engine (tree/integration/liveness axes, squash-proof reconciliation, ForgeClient, provenance join, ls --status)
- 94daa59: Add `agentproto policy` verb (attach|status|wait|ack|ls|cancel)
- 3e99abf: Split worktree.cleanup --force into discardUntracked/discardModified flags; add rm/archive CLI verbs and salvage writer
- a63b4bc: Add worktree new verb, worktrees.root config, and provision provenance marker
- ea44602: Add sessions story subcommand and expose runtime/session-story subpath export
- 47d3251: Add `worktree gc` command: plan/apply/salvage cleanup sweep over linked worktrees

### Patch Changes

- bd57d69: Add @agentproto/adapter-pi: AIP-45 proprietary-arm adapter for earendil-works/pi
- afbf5c4: Register claude-opus-4-8, claude-sonnet-5, claude-fable-5 in pricing catalog; decouple runnable from pricing presence
- fe0d6f0: Fix sessions wait --until default timeout (15m) and timeout exit code (2)
- 58e4a83: Distinguish idle-after-turn from never-run in sessions status badge and detail pane
- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- 4f62f46: Fix worktree archive ENOENT by resolving the main repo root via --git-common-dir
- 8a4d5d5: Add opt-in E2E encryption for the serve --connect tunnel (tunnel-e2e/v1)
- d425044: Add catalog-sourced billing-credential resolver for all adapters
- 2d94149: Fix gateway auth collision, adapter cache invalidation, and proxy model alias override
- 3639abd: Default pair offer to the hosted rendezvous broker when nothing is configured
- a32bb69: Bump test timeouts on subprocess/IO-heavy tests that flake under parallel load
- 0839e5f: Fix gc salvaging dirty fresh worktrees; add recent-write hold window
- Updated dependencies [1bdc055]
- Updated dependencies [afbf5c4]
- Updated dependencies [7b53b8c]
- Updated dependencies [5ae8c13]
- Updated dependencies [049c2fe]
- Updated dependencies [0ea6fc1]
- Updated dependencies [6d4aa4b]
- Updated dependencies [386a573]
- Updated dependencies [c036f59]
- Updated dependencies [60792f1]
- Updated dependencies [4f62f46]
- Updated dependencies [76747fc]
- Updated dependencies [6db7c6a]
- Updated dependencies [8a4d5d5]
- Updated dependencies [d425044]
- Updated dependencies [2d94149]
- Updated dependencies [d924e95]
- Updated dependencies [20add88]
- Updated dependencies [e44242d]
- Updated dependencies [2bed7e6]
- Updated dependencies [234b2e6]
- Updated dependencies [3639abd]
- Updated dependencies [3e99abf]
- Updated dependencies [a63b4bc]
- Updated dependencies [47d3251]
- Updated dependencies [a32bb69]
- Updated dependencies [0839e5f]
- Updated dependencies [c8198c6]
  - @agentproto/model-catalog@0.3.0
  - @agentproto/acp@0.5.0
  - @agentproto/auth@0.1.1
  - @agentproto/driver-agent-cli@1.0.0
  - @agentproto/driver@0.1.3
  - @agentproto/provider-kit@0.2.1
  - @agentproto/runtime-profile-standard@0.1.2
  - @agentproto/secrets@0.2.0
  - @agentproto/worktree@0.3.0
  - @agentproto/adapter-browser@0.1.1
  - @agentproto/rendezvous@0.2.0

## 0.5.0

### Minor Changes

- 7142f1c: Add per-mode support status (active|noop|planned) to AIP-45 agent-CLI manifest
- 0ba77de: Add --pack fan-out install for skill CLI
- 0205f6c: Rewrite auth login onto the @agentproto/auth device-code engine (WP-5)
- 9fe8586: Add refreshOnly mode + CeremonyRequiredError; honor --no-browser; silent serve refresh
- 2f380c8: Add `agentproto auth cred set|list|rm` to seed broker credentials for child-MCP auth
- 13e118d: Add --source flag to 'pack skill' for cross-repo sourceDir override
- a28bebc: Add provider-presets catalog listing and AIP-45 presets manifest field
- b588e36: Add a `defaults` block to `~/.agentproto/config.json` — global and per-adapter `skills`/`options` auto-applied to every `agent_start` spawn. A normalized `skills: string[]` is folded into the resolved adapter's native option shape (e.g. hermes' comma-joined `--skills a,b`); adapters with no declared `skills` option are a no-op.

### Patch Changes

- 6b8b023: Add bin_args_prepend, plumb options map, and declare lean modes on agent-CLI adapters
- 81e0292: Add first-party claude-sdk adapter (headless query() over ACP, model + base_url)
- c4873a2: fix MCP Apps panels: forward resources/\* through mcp-bridge + spec-correct ui/initialize handshake
- b77a552: Rename adapter-kit → provider-kit; add adapter-kit@0.2.0 compatibility shim
- fdb8ea1: Add credentialRef + headers to AcpMcpServer for brokered child-MCP auth at spawn time
- 8a08ed6: Make manifest sourceDir optional and expand ${ENV_VAR} references before resolving
- 2d3038c: Fix run-swarm role paths, claude permission hang, and per-participant model config
- 2d6aead: Fix session_restart resuming wrong conversation via fs-probe sibling leak
- 12b9ed5: Fix install bootstrap, serve/run --help crash, and models empty-state hint
- Updated dependencies [6b8b023]
- Updated dependencies [80ca385]
- Updated dependencies [7142f1c]
- Updated dependencies [6f867e1]
- Updated dependencies [6a5c41c]
- Updated dependencies [6c83622]
- Updated dependencies [3a76562]
- Updated dependencies [c359894]
- Updated dependencies [829a6c0]
- Updated dependencies [547c796]
- Updated dependencies [b77a552]
- Updated dependencies [83ce80f]
- Updated dependencies [c69d424]
- Updated dependencies [6a0d8fe]
- Updated dependencies [e94757d]
- Updated dependencies [d993560]
- Updated dependencies [9fe8586]
- Updated dependencies [da9f77a]
- Updated dependencies [fdb8ea1]
- Updated dependencies [b65ca15]
- Updated dependencies [2d3038c]
- Updated dependencies [a28bebc]
- Updated dependencies [7f8b45a]
  - @agentproto/driver-agent-cli@0.4.0
  - @agentproto/acp@0.4.0
  - @agentproto/auth@0.1.0
  - @agentproto/provider-kit@0.2.0
  - @agentproto/runtime-profile-standard@0.1.1

## 0.4.0

### Minor Changes

- 096e8b3: Migrate chat-tui renderer from Ink/React to @earendil-works/pi-tui
- 1759ffc: Add install-mcp command for one-shot MCP registration with coding-CLI agents
- 17aff95: Add durable cron scheduler with MCP tools, REST routes, and CLI verb
- 5c207ca: Add scriptable session/policy wait — REST endpoints and CLI subcommand
- 1d78a32: sessions start: add --orchestrator, --orchestrator-json, --mcp-servers-json flags
- 1d8d9b4: Add `agentproto install skill/<slug>` command with hermes and claude-code targets
- 79a209a: Add structured per-session transcript capture and daemon-events export source
- 75ffe74: Add claude-desktop target to `install skill` with manifest upsert and backup
- be164fe: Add hermes target to install-mcp (surgical config.yaml upsert/remove)
- c61093f: feat(cli): add `agentproto onboard` first-run umbrella (register MCP + install skill pack)

### Patch Changes

- 06132bc: Implement the AIP-45 `protocol: "proprietary"` arm end to end: `createProprietaryProtocolArm` now dynamic-loads an adapter's `createAgentCliClient` factory and `createAgentCliRuntime` skips the subprocess spawn for it. Ship `@agentproto/adapter-mastracode-inprocess`, a new adapter driving Mastra Code in-process via its SDK (`createMastraCode` + `runMC`) instead of spawning the CLI, with a composite `resourceId:threadId` session id that verifiably survives a process restart. Register the new `mastracode-inprocess` slug in the CLI's adapter catalog.

  Fix `resolveAdapter` to rewrite a `protocol: "proprietary"` handle's `adapter` field to a fully-resolved absolute path before handing it off — `createProprietaryProtocolArm` re-imports that field a second time from `@agentproto/driver-agent-cli`'s own module location (which deliberately depends on no specific adapter), so a bare package-name specifier that resolved fine during discovery could fail to resolve at session-start. Applies to every proprietary adapter, not just this one.

- b6887aa: Fix chat-tui inline code rendering, prompt-echo regex, and cast consolidation
- f25d0ab: render inline code without backticks and fix prompt-echo dash match
- 2d1434a: Add mastra-jsonl print-arm schema, AgentCliPrintConfig, and adapter-mastracode
- 16d52cd: Add WorkflowRunner primitive, deferred tool gateway, structured awaiting-input, and agent_start mode wiring
- 83aa850: Add session liveness tracking: pid, lastActivityAt, processAlive on SessionDescriptor
- 872226b: Add per-turn silence watchdog to ACP client to fix hermes hang-without-turn-end
- f28c925: Surface busy/idle and stale-running (dead pid) state in sessions dashboard
- 5616041: Add session_restart MCP tool and extract shared resume decision tree
- 111a599: Add prompt-session cron action to re-prompt a live session
- 06132bc: Implement AIP-45 proprietary protocol arm; ship adapter-mastracode-inprocess
- 3ab696d: Render tool calls/results informatively instead of the generic `[tool] view` line
- 3635eb8: fix(cli): skill install no longer crashes overwriting a file/symlink dest
- Updated dependencies [06132bc]
- Updated dependencies [2d1434a]
- Updated dependencies [1bf295b]
- Updated dependencies [83aa850]
- Updated dependencies [872226b]
- Updated dependencies [78d09e6]
- Updated dependencies [559cff3]
- Updated dependencies [06132bc]
- Updated dependencies [c2b6779]
- Updated dependencies [3ab696d]
- Updated dependencies [79a209a]
- Updated dependencies [e27fc94]
- Updated dependencies [837967a]
  - @agentproto/driver-agent-cli@0.3.0
  - @agentproto/acp@0.3.0

## 0.3.0

### Minor Changes

- 4068f04: add chat-tui command — Ink TUI with markdown rendering
- 7a310ff: Add model-catalog package, provider-key store, and `agentproto models` command
- 4068f04: add chat-tui command — Ink TUI with markdown and syntax highlighting
- fd03e5c: Add live-on-setup voice overlay and fix OpenRouter cache field names

### Patch Changes

- Updated dependencies [7a310ff]
- Updated dependencies [fd03e5c]
  - @agentproto/model-catalog@0.2.0

## 0.2.0

### Minor Changes

- ea9be98: Wire the browser CLI verb into the router and register browser MCP tools (start_browser / list_adapter_browsers) in the gateway.
- fc6fd0b: Add session cost/cap, wait:true one-shot, clean output, model echo, wait_for_any cursor
- c86ec37: Add `agentproto chat` interactive multi-turn REPL and `--model` to `sessions start`
- 43f9c8a: Add central daemon registry so CLI discovers a daemon from any cwd
- 5c2063e: Thread mcpServers through spawn to ACP newSession/loadSession; add named Cloudflare tunnel provider
- 0d3b8f9: Add @agentproto/adapter-kit and migrate tunnel/browser/CLI adapter families onto it
- 7a89e37: Surface exportAgentSession via export_session MCP tool and sessions export CLI
- d30973e: add mcp-bridge stdio command — proxy daemon HTTP /mcp to stdio MCP clients
- cfbeb8f: Browser-as-adapter stack: adapter-browser, browser-process primitive, `agentproto browser` CLI

### Patch Changes

- 04c9a5a: Wire `print` protocol arm: add `"print"` to `AgentCliProtocol` + schema enum, short-circuit in `createAgentCliRuntime.start()` to call `createPrintSession` directly (the print arm spawns per-turn, not a long-lived `AgentCliClient`), export `createPrintSession`/`PrintArmOptions` from the package index, and publish the `skill/` directory from `@agentproto/cli`.
- adf4583: Add print-arm protocol driver, AIP-52 harness schema, and agentproto SKILL.md
- f2e94ab: Declare opencode/codex/openclaw adapters as workspace devDeps of CLI
- c3cd0cc: Add @agentproto/adapter-mastra-agent first-party Mastra-backed ACP agent
- c22d1fb: docs: list first-party mastra-agent adapter in README, getting-started, skill
- 250f474: Migrate tunnel providers onto a slug-keyed adapter-kit registry; ngrok now creatable end-to-end; third-party providers pluggable
- 0022b2a: Thread mcpServers through spawn to ACP newSession/loadSession (orchestrator WP1)
- 6587000: Honor model and add effort to start_agent_session for claude-code adapter
- 6738ef9: Surface adapter manifest (location/install/config) over MCP; add binPath to start_browser
- ec769ab: Extract daemon helpers, add POST /sessions/browser route, fix stop_browser return shape
- 04c9a5a: Add `print` protocol arm: new AgentCliProtocol member, createPrintSession export, skill/ publish
- Updated dependencies [e33d99a]
- Updated dependencies [04c9a5a]
- Updated dependencies [adf4583]
- Updated dependencies [c6a90e2]
- Updated dependencies [7542339]
- Updated dependencies [250f474]
- Updated dependencies [8a24b4b]
- Updated dependencies [5c2063e]
- Updated dependencies [0022b2a]
- Updated dependencies [4baab31]
- Updated dependencies [6587000]
- Updated dependencies [6738ef9]
- Updated dependencies [0d3b8f9]
- Updated dependencies [7fec1bc]
- Updated dependencies [4b2c9ec]
- Updated dependencies [04c9a5a]
- Updated dependencies [cfbeb8f]
  - @agentproto/adapter-browser@0.1.0
  - @agentproto/driver-agent-cli@0.2.0
  - @agentproto/acp@0.2.0
  - @agentproto/adapter-kit@0.1.0
  - @agentproto/driver@0.1.2

## 0.1.3

### Patch Changes

- 1fc1750: Add loadAgent, updateManifestSet, self_inspect MCP tool, and extends-chain validation
- 1fc1750: Add loadAgent, validateExtendsChain, updateManifestSet, and self_inspect MCP tool
- Updated dependencies [1fc1750]
- Updated dependencies [1fc1750]
  - @agentproto/driver@0.1.1

## 0.1.2

### Patch Changes

- 44192c9: Add self_inspect MCP tool, extends-chain validation, driver MCP verb, and atomic manifest writes
- Updated dependencies [44192c9]
  - @agentproto/driver@0.1.0
