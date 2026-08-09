# @agentproto/cli

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
