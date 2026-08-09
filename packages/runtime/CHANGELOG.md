# @agentproto/runtime

## 2.3.0

### Minor Changes

- 29acda3: Add optional `encoding` parameter to `file_read` MCP tool to support base64 encoding for binary files, fixing corruption of binary content (PNGs, audio, video, etc.) that was caused by UTF-8 decoding. Default behavior unchanged — existing callers continue to receive UTF-8 text as before.
- 5f2ebb8: Add prompt provenance tracking to transcript records and webview, enabling accurate attribution of supervisor-orchestrated turns. When one agent session prompts another (via `agent_prompt` or spawn with `initialPrompt`), the originating session ID is now recorded as the turn's source and displayed in the conversation UI as "SUPERVISOR ASKED" instead of "YOU ASKED". The feature is backward-compatible: existing transcripts and API call sites are unaffected, and source fields are optional everywhere.

### Patch Changes

- a26d527: Add child→parent report-back communication channel: new `message_parent` MCP tool for child sessions to send messages/status updates to their parent supervisors, plus `AGENTPROTO_PARENT_SESSION_ID` environment variable for lineage discovery. Includes automatic scope injection for gateway-less children and comprehensive test coverage.
- 1bce78e: Persist permission resolution in the durable transcript so the conversation UI can display resolved permissions and clear the "Awaiting your decision" state. Permission-resolved events are keyed by toolCallId to correlate with their originating agent-prompt asks.
- Updated dependencies [08bcd4a]
  - @agentproto/driver-agent-cli@2.2.1

## 2.2.0

### Minor Changes

- 087f0ea: Declarative agent steps for AIP-15 workflows (WP-B4): author `kind:"agent"` steps with `agent.ref` (app-scoped agent ids) that resolve at compile time to concrete adapters + spawn options. Includes app installation/lifecycle tools (`app_install`, `app_run`, `app_list`, `app_status`, `app_stop`) for managing installed-app state and running agents as live sessions. Tool-id validation now shifts from STEP-DISPATCH time to INSTALL time, listing all missing ids upfront instead of failing one-at-a-time.
- 5e75a57: Add progressive step status reporting to workflow execution via optional `onStepStart` and `onStepComplete` callbacks. Steps now transition through pending → running → done states during execution, rather than remaining pending until workflow completion. This enables real-time progress tracking for long-running workflows.
- 2962637: **Feature: Agent step output text threading in workflows**

  Agent steps can now automatically capture their text output and inject it into subsequent steps' prompts, enabling multi-step workflows to share context and analysis. The workflow runtime captures the final message from each agent step (when `readFinalMessage` is available) and threads it through the bindings, making it accessible to downstream steps via the AIP-16 Selector pattern. Previous step outputs are formatted as `[Output from step "id"]\ntext` and prepended to the base prompt, improving agent reasoning across sequential steps.

- 2b379e9: Add app dependency management and scope mount tracking. Introduces `requires` field on apps to declare dependencies, new MCP tools (`app_apply`, `app_unapply`, `app_list_applied`) for managing app mounts to scopes, HTTP endpoints mirroring the tools, and AppRegistry enhancements for persistence of applied mounts with dependency validation.

### Patch Changes

- 48b4302: Add app\_\* daemon tools (app_install, app_list, app_run, app_status, app_stop) for @agentproto/app-kit lifecycle management. Tools enable installing bundled agent-workflow apps, running agents as live sessions, and monitoring app execution. Moves workflow tool-id validation from step-dispatch time to install time, reporting all missing tool ids at once instead of failing one step at a time.
- Updated dependencies [4b6bbe6]
- Updated dependencies [3e187e5]
- Updated dependencies [47ca357]
- Updated dependencies [087f0ea]
- Updated dependencies [5e75a57]
- Updated dependencies [2962637]
- Updated dependencies [492240c]
- Updated dependencies [2b379e9]
  - @agentproto/model-catalog@0.8.1
  - @agentproto/driver-agent-cli@2.2.0
  - @agentproto/app-kit@0.4.0
  - @agentproto/workflow@0.2.0
  - @agentproto/workflow-runtime@0.7.0
  - @agentproto/providers-store@0.3.4
  - @agentproto/sandbox@0.2.2
  - @agentproto/workflow-loader@0.1.3
  - @agentproto/eval-reporters@0.2.6
  - @agentproto/telemetry-langfuse@0.2.4

## 2.1.0

### Minor Changes

- 678bc1a: Session identity environment variables: inject `AGENTPROTO_SESSION_ID` and `AGENTPROTO_WORKSPACE_SLUG` into every process spawned by the daemon on a session's behalf (agent adapters, terminals, commands, cron jobs). Each spawn gets its own freshly minted id; the variables are set last to prevent caller forgery. This enables spawned processes to report back session context, tag telemetry, and nest child sessions under parent sessions via `parentSessionId`.
- 6280066: Add WP-D structured verdict parsing for judge gates, with optional JSON-based verdict format supporting findings/severity metadata. Judge gates can now pin a custom billing profile via `access.profileRef` to avoid wallet rate-limiting. New types: `JudgeVerdict`, `VerdictSeverity`, `VerdictFinding`. New gate spec fields: `judge.access`, `judge.route`, `judge.mode`. Verdict is persisted and echoed on `policy:passed`/`policy:failed` events. Backward compatible: existing plain-text verdicts work unchanged; JSON blocks are optional.
- b99245b: Default `agent_start` dedupe to deriving an implicit idempotency key. A retry provoked by a lost or slow response previously forked a second session unless the caller remembered to pass `idempotencyKey` — a guard that only works when asked for is not a guard, the same argument `spawn.attach` already settled for parent lineage. New daemon-side `spawn.dedupe` policy on `SpawnConfig` (`AGENTPROTO_SPAWN_DEDUPE` env > config > default `"always"`), which derives a key from `label` + a hash of the initial prompt. No label means no implicit key at all, so deliberate unlabelled parallel fan-out into one cwd is structurally excluded. Implicit claims use a shorter window (120s) than explicit ones (600s) — a guess should not be trusted as long as a promise. Per-call `dedupe: false` opts out, mirroring `attach: false`; `dedupeSource: "explicit" | "implicit"` is surfaced on the result so a caller can tell the two apart.
- fd3e287: **WP-E (spawn-dedupe-default)**: Add implicit idempotency key derivation to prevent accidental spawn duplicates without requiring explicit opt-in. When a spawn carries a `label` and no `idempotencyKey`, the daemon derives an implicit key from the label plus a hash of the initial prompt. Same-adapter/cwd/key spawns within ~2 minutes are deduped (shorter window than explicit keys to reduce false collisions). Label-gated derivation preserves the fan-out safety pattern where unlabelled parallel spawns must remain distinct. New config field `spawn.dedupe` ("always" default / "on-request") controls policy; per-call `dedupe: false` escape hatch.

  **WP-F (worktree async provisioning)**: Enable fast-return session registration with background worktree provisioning, and share a single turbo build cache across all provisioned worktrees. `worktree: { async: true }` opts in: returns immediately with status "starting", provisioning + driver spawn continue in background. New registry methods `spawnAgentPending` / `settlePendingAgent` manage placeholder lifecycle. New `resolveWorktreesTurboCacheDir()` export provides shared cache path to setup hooks, eliminating cold builds on every worktree provision.

### Patch Changes

- c825a12: Sync generated catalog data from the pinned provider sources.

  catalog-sync and runtime are named because their `src/__tests__` assertions
  had to follow the refreshed data (context-window entry count, gpt-5.6 tier
  repricing), and the coverage check counts anything under `src/` as
  publish-affecting.

- 832870d: Documentation sync: daemon restart command, sessions gc garbage collection, install --allow-unverified flag, Gemini adapter shipped, pi adapter support, xai-anthropic and llm-endpoint provider presets, and launchd crash-only KeepAlive behavior.
- c1399f3: Weekly dependency update: bump @modelcontextprotocol/sdk, @mastra/core and ecosystem packages, turbo, tsx, and React types to latest patch/minor versions within semver constraints.
- 8228d88: Add dep-bump reclaim exemption for worktree GC: safely promote clean, unpushed worktrees from `hold` to `reclaim` when all commits are mechanical dependency bumps (subject and cumulative diff validation). Addresses storage bloat from recurring automated dependency-bump worktrees piling up as permanent holds. Includes comprehensive test coverage and applies re-validation at apply time (layer 2).
- 980276e: Router-aware LLM model enumeration for Requesty and HuggingFace.

  Introduces `listRouterLlmRoutes` to systematically enumerate all models a router serves, and enhances `getModelsByProvider` to fold these router tables into provider queries while deduplicating against OpenRouter's existing bare-id surface. Requesty and HuggingFace models now enumerate from their generated route tables as `vendor/product@router` ids. Claude SDK adapter adds Requesty model curation to its allowed list.

- df10f28: Fix spawn-claim deduplication window to match real retry latencies: increased from 30s to 10 minutes to absorb the caller's timeout (300s) plus network/clock skew, with an LRU size backstop (1,000 resolved claims) to prevent unbounded growth. Add non-blocking warning when two live sessions share the same label+cwd, aiding incident detection without breaking legitimate fan-out patterns.
- Updated dependencies [c825a12]
- Updated dependencies [832870d]
- Updated dependencies [c1399f3]
- Updated dependencies [980276e]
  - @agentproto/model-catalog@0.8.0
  - @agentproto/provider-presets@0.5.1
  - @agentproto/mcp-server@0.2.5
  - @agentproto/provider-kit@0.4.1
  - @agentproto/providers-store@0.3.3
  - @agentproto/eval-reporters@0.2.5
  - @agentproto/sandbox@0.2.1

## 2.0.0

### Major Changes

- ff9c348: Fold RoutineRunner into AIP-15 workflow; routine\_\* verbs become deprecated workflowRunner aliases
- 68ef7fb: Add operator-configurable custom routes via `~/.agentproto/routes.json` and a new `xai-anthropic` gateway preset.

  **Breaking change (`@agentproto/runtime`):** `registerBuiltinRoutes()` is now `async` (`() => Promise<void>`, previously `() => void`), because it now also loads and validates operator routes from `~/.agentproto/routes.json` before returning. Any external caller must add `await`:

  ```diff
  -registerBuiltinRoutes()
  +await registerBuiltinRoutes()
  ```

  Callers that do not await the returned promise will silently skip operator-route loading (built-in routes still register synchronously before the first `await` point, but overrides from `routes.json` will not be applied and no rejection will surface). All internal call sites in this repo have been updated.

  `@agentproto/provider-presets` gains the `xai-anthropic` preset: an Anthropic-schema-compatible gateway pointed directly at xAI, for hosts that want to address Grok through the Anthropic wire format.

### Minor Changes

- c736c02: Dissociate auth profiles from routers/gateways and harness adapters. Session descriptors now carry explicit `harness`, `model`, `route`, and `accessProfile` identity. Runtime resolver derives api-key auth from the model and gateway route, injecting `base_url` + credential env without adapter hard-coding. Add native Moonshot support to `pi`, decouple `claude-sdk` from hard-coded gateway modes, and register a local `llm-endpoint` preset.
- 15e15db: Add context-continuity policy, structured checkpoints, and fresh continuation for long-running agent sessions.
  - Resolve context-continuity policy (manual / ask / auto) with configurable warn/compact/continue-fresh/hard-stop thresholds.
  - Build and persist bounded structured checkpoints next to the source session's events.jsonl.
  - Spawn a fresh continuation session with the same adapter, model, route, access, posture, cwd, and MCP servers, linked via `continuedFrom`/`continuedTo`.
  - Add MCP tools: `session_context_status`, `session_checkpoint`, `session_compact`, `session_continue_fresh`.
  - Surface compact and continue-fresh actions in the VS Code sessions panel.

- 9bb814f: Add attachment support and MarkdownV2 formatting to transmit_message
- 96b22d5: add tool-cli CLI projection and session PR provenance tracking
- 6a0a60c: add daemon PR-provenance reconciler and open-PR resolver
- 013e7b3: Carry provider auth headers through attach; fix Box boot auth
- 2ec1af8: Add the semantic hook engine core (Plane 1): `.agentproto/hooks.json` schema + loader (`hooks-config.ts`, mirroring the `allowed-commands.json` cache pattern) and a rule-driven `decide(rules, {tool, command, args}, fallback)` evaluated at the pre-exec permission seam, generalizing the old `permissionHold` boolean into `allow | hold | deny`.
  - Every rule carries a required `plane: "semantic" | "blast-radius"` tag; `decide()` only consults `"semantic"` rules (the ACP permission seam), leaving `"blast-radius"` rules as declared-but-unwired substrate for the OS-sandbox plane.
  - RISK-0 GUARD: the loader refuses to load a rule that declares `intent:"security"` with `plane:"semantic"` and `action:"hold"` or `"deny"` — a Plane-1 hold/deny is bypassable (bypass posture, in-process tools, non-ACP harnesses) and would be a false sense of safety for a security rule.
  - LOG-ONLY DEFAULT: no `.agentproto/hooks.json`, or one containing only `action:"log"` rules, reproduces today's `permissionHold`-boolean behavior exactly — this PR ships the engine + config substrate, not any enforcing rule. `deny` decisions currently degrade to the same hold-for-human path as `hold` (no auto-deny wiring yet).

- 8367648: rename auth 'vendor' axis to 'endpoint' in profiles and manifests. The v1
  `~/.agentproto/auth-profiles.json` disk format deliberately keeps `vendor` for
  backward compatibility; the public TypeScript API exposes only `endpoint`.
- 70ee0db: Add AIP-45 mode support to CronAction agent type: `mode` (mode id), `permissionHold` (start in permission-hold mode), and `options` (manifest-declared option ids). These optional fields are properly threaded through `startSession` and `spawnAgent` calls with conditional spreading to maintain backwards compatibility.
- d10ed02: Add worktree-status query surface (MCP tool + HTTP route). Exposes git worktree status with live PR integration and session linkage via `worktree_status` MCP tool and `GET /worktrees` HTTP endpoint. The heavy join lives in `@agentproto/worktree` and is injected at the daemon's composition root, keeping the runtime free of that dependency.
- 831d4f5: Implement route-selection axis for AIP-45 launch-menu drill-down (WP1): add declarative `routeSelection` field to adapter manifests (distinguishes "free" vs. "derived-from-model"), project it through resolve/runtime layers, enrich catalog with per-route `multiModel` flags and flat routes index for tier-pinning logic.
- b04dba5: Add daemon-lane PR provenance stamping: relocate footer generation logic from `scripts/lib/provenance-footer.mjs` into a new pure `pr-provenance` submodule so daemon's `command_execute → gh pr create` path can stamp the same `@agentproto-bot` footer (byte-identical CI format, with daemon-specific auth-profile/supervisor/host/cwd fields) as the CI lane. Include `pr-provenance-stamp` orchestration module for best-effort stamping with idempotency and comprehensive error handling.
- d90fdc0: Add spawn-time money-safety guard that rejects gateway/router models on incompatible wallets. Exports three new functions: `serviceableModelRoutes()`, `checkModelWalletEligibility()`, and `modelWalletIneligibleMessage()`. Adds new `model_wallet_ineligible` error code to `SpawnAgentSessionResult`. The guard prevents silent 404s when a model bills to a different route than the resolved wallet can provide (e.g., DeepSeek on Anthropic's wallet when it requires OpenRouter).
- 6ff42b4: feat(auth,runtime): auth-profile create/delete flow. Provision named subscription and api-key auth profiles from the daemon via the `auth_profile_create` / `auth_profile_delete` MCP verbs, backed by a `profile-provision` helper that writes the profile descriptor and stores the credential in the OS keychain. Surfaced in VS Code as a create/delete UI on the auth-profiles tree.
- 7e78a37: Add trusted `parentSessionId` lineage hint (WP-R1) and `session:spawned` event (WP-R3) to enable agent-to-agent spawn attribution and real-time tree updates. The scoped orchestrator gateway's token always wins over hints, maintaining unspoofable parent derivation for nested spawns while filling the depth-0-orphan gap for root-path spawns.
- a3deef9: Fix session display name precedence: derived titles now outrank spawn labels

  Introduces a `renamedByUser` flag to distinguish user-renamed labels from spawner-supplied labels. This allows the derived title (first sentence of the first prompt) to outrank spawn labels in the display precedence, preventing slugs like "auto-title-precedence-fix" from shadowing useful titles. User-explicit renames still win.

  Breaking compatibility: None. Sessions persisted before this change treat an absent `renamedByUser` flag on a labelled session as "user-renamed" to preserve prior edits; only new spawns stamp the flag explicitly.

- 61b23e0: Implement adapter installation API for harnesses: add `POST /adapters/:slug/install` HTTP route and `adapter_install` MCP tool to install not-yet-ready agent CLI adapters. Supports both acp-catalog CLIs (npm-global) and first-party workspace adapters (manifest install pipeline). VS Code extension UI integration with context-aware install button for installable harnesses.
- 3948ef9: Add support for four new universal conversation stores (codex, opencode, mastracode-inprocess, pi) with discover and export interfaces. Enables session recovery across diverse harnesses with comprehensive error handling and support for role mapping, timestamps, reasoning blocks, and tool calls.
- 443507d: Add `listImportCandidates` for universal conversation import across multiple harnesses. The new function discovers external conversations (claude-code, hermes) that can be reattached as live sessions, replacing claude-code-only logic with a store-agnostic abstraction. Generalizes over `ConversationStore.attachArgv` — any harness with native reattach capability can now be discovered and reattached.
- fa2e0c9: Add interpreter detection and warning to `command_execute`: export `INTERPRETER_BASENAMES`, `isInterpreterBasename()`, and `interpreterExecWarning()` to help users avoid the security footgun of allowlisting code interpreters (bash, node, python, etc.), which can grant arbitrary host code execution despite workspace cwd anchoring. Warnings are logged once per interpreter per daemon session and included in the result JSON for visibility without blocking.
- b55c58d: Add macOS Seatbelt-based OS-level confinement for `command_execute` subprocesses (phase 2). Introduces opt-in `.agentproto/command-sandbox.json` config with three modes: "off" (default, no change), "workspace" (deny access to home directory outside workspace, protect credentials), and "strict" (add network denial). Backends are platform-specific; returns null on non-macOS platforms. Original command/args preserved in provenance; only spawned argv is wrapped. Comprehensive test coverage including end-to-end macOS Seatbelt validation.
- 589dc04: Add Mode 3 (self-refreshing OAuth) support for subscription credentials. Allows the runtime to read the Claude Code OAuth token fresh from the local login on every spawn via the `claude-code-oauth` provision recipe, implementing automatic token refresh without static token management.

  New exports: `resolveSubscriptionCredential()`, `SubscriptionSourceError`, `CLAUDE_CODE_OAUTH_SOURCE`, extended `CredentialSource` type.

  Fixes precedence logic (explicit-token > source-resolved-fresh > config-static-token) and adds loud error handling for unknown sources or resolution failures.

- d3f6f85: Add `gcSessions()` method to bulk garbage-collect terminal sessions — archive (default, reversible) or forget (drop descriptor to reclaim disk). Supports age-based and scope-based filtering, never touches live sessions. Exposed via MCP tool `session_gc`.
- f669026: Add unified Activity read-model (policies, turns, routines, workflows, PRs) with MCP tool and HTTP endpoint
- 2efea7d: Add provenance tracking for command sessions via `origin` and `callerSessionId` fields.
  - `SessionDescriptor` now includes optional `origin` (source label: "command_execute", "cron", etc.) and `callerSessionId` (session that invoked this one)
  - `command_execute` tool accepts optional `origin` parameter, defaults to "command_execute"
  - Cron scheduler stamps `origin: "cron"` on scheduled command sessions
  - Transcript export includes provenance fields in metadata and renders them in markdown output
  - All changes backward compatible; fields are optional and only set when provided

- 8f5e5cd: Add Task-to-Activity linking via read-time join. Introduces `ActivityTaskLister` interface and `linkTasks()` function that enriches activity records with `taskId` — turns link to the OPEN task their session owns; policies link to the task whose verify gate is that policy. Also adds `snapshot()` method to `TaskLedger` interface for unscoped task access needed by the Activity projector. Maintains clean separation: Task stays the source of truth for INTENT, Activity for EXECUTION.
- 645279d: Add support for source-backed auth profiles — named profiles that resolve credentials fresh from self-refreshing sources (e.g. `claude-code-oauth`) instead of storing a static secret. Session spawn resolves source-backed profiles via Mode 3 credential resolution on every spawn; session restart explicitly rejects them (out of scope for restart, follow-up planned).
  - `AuthProfile.credentialRef` now optional, new mutually-exclusive `source` field
  - `validateCreateInput` enforces exactly one of `credential`/`source` for oauth-bearer, requires `credential` for api-key
  - Session spawn: source-backed profiles resolve fresh credential each time via `resolveSubscriptionCredential`
  - Session restart: source-backed profiles fail loud with `RestartOverrideError`
  - New tests: profile provisioning with source, session spawn with source, restart rejection of source

- 6c1948d: Add `boardId` spawn-time board pinning: allow clients to pin spawned agent sessions to explicit task boards via optional `boardId` parameter on `agent_start` (MCP) and HTTP spawn endpoints. The spawned board pin (`meta.boardId`) takes precedence over lineage-derived board resolution, enabling cowork-style operators to fan out multiple depth-0 root sessions onto a shared board without shared lineage. Backward-compatible: all new fields are optional, existing spawns unaffected.
- 5ba2032: Add rawInput field propagation through permission-hold system. The tool call's raw input (e.g. Bash command string) now flows from requestPermission RPC → agent-prompt event → PendingPermission object → HTTP/MCP APIs, surfacing in the CLI `permissions ls` table as a truncated preview for enhanced transparency in permission request review.
- ca4b091: Add optional `hint` field to `session_monitor` MCP tool response. When a polling timeout occurs, the hint guides callers toward the uncapped `agentproto sessions wait` CLI command. Improve docstrings for `agent_start` and `session_monitor` tools to clarify CLI equivalents.
- 0515531: Unified tool-call logging for both proxy (command_execute) and in-agent (Bash, Read, Edit) paths via normalized ToolCallRecord interface. Adds tool_calls_list MCP tool to query records across sessions, joined with session-level provenance (harness, origin, callerSessionId) at read time.
- 3c0ef25: Add git-worktree garbage collection surface: `POST /worktrees/gc` HTTP route and `worktree_gc` MCP tool powering the daemon's worktree management. Defaults to dry-run mode; requires explicit `apply: true` to execute. Design maintains architectural isolation from `@agentproto/worktree` via an injected runner port, mirroring the `worktree_status` pattern.
- 230f378: Export orphan reaping utilities for custom orchestrator implementations. Adds `reapOrphanedDescendants` function and `OrphanReaperRegistry` interface to the public API, enabling users to implement custom child-session lifecycle management when parent sessions exit.
- 392021a: Add config-file surface and `agent_start` MCP exposure for adapter-spawn command sandboxing (PR 6b continuation):
  - **Config-file surface**: New `.agentproto/command-sandbox.json` `adapterSpawn` key (distinct from `command_execute`'s top-level `mode`) with separate env-var escape hatch (`AGENTPROTO_ADAPTER_COMMAND_SANDBOX_MODE`) to control adapter-spawn confinement persistently, justifying explicit opt-in due to larger blast radius.
  - **MCP exposure**: `commandSandbox?: "off" | "workspace" | "strict"` added to `agent_start` schema; forwarded through runtime and driver layers.
  - **Bug fix**: `serve.ts` was silently dropping `commandSandbox` from the opts destructure; fixed by including it in the spread and adding the type to `AgentAdapterResolver.startSession`.
  - **Credential access gap** (PR 6a follow-up): Added read-only paths to adapter-spawn defaults (`~/.gitconfig`, `~/.config/git`, `~/.config/gh`, `~/Library/Keychains`) fixing `git ls-remote` and `gh auth status` failures under `workspace` mode confinement.
  - **Async change**: `wrapAgentCliSpawn()` now async to support config-file loading; all callers updated.

  Backwards compatible: default behavior unchanged when no config and no explicit mode.

- bd24703: Implement `action:"gate"` for the hooks engine — shell commands that auto-resolve permissions from exit codes. Factors out gate execution into a shared `runShellGate()` function (reused by both turn-end policy gates and hook-engine gates), ensuring identical behavior and reducing duplication. Includes comprehensive test coverage and properly maintains the RISK-0 guard against security-intent rules on Plane-1. New exports: `decideRule()`, `runShellGate()`, `HookGateSpec`, `ShellGateOutcome`.
- 173cff1: Add argv-level allowlist matching and callerSessionId provenance threading for command_execute.

  Allowlist entries can now constrain command arguments (e.g., allow `git status` but deny `git push`), while plain string entries remain unconstrained for backward compatibility. Session ID pre-minting enables tracking which agent session invoked a command through the MCP gateway.

- 17b503a: Harden daemon lifecycle for idempotent startup under launchd supervision:
  - **KeepAlive crash-only restart**: Changed plist `KeepAlive` from always-restart (`<true/>`) to crash-only (`<dict><SuccessfulExit>false</SuccessfulExit></dict>`). This allows clean exit-0 to stay settled, enabling idempotent `serve` startup when a healthy daemon already owns the port.
  - **Split `daemon start` into idempotent-launch vs force-cycle**:
    - `agentproto daemon start` now uses `kickstart` (no `-k`): idempotent, leaves a healthy daemon running.
    - `agentproto daemon restart` uses `kickstart -k`: force-cycle, kills and relaunches (replaces `pnpm killport 18790`).
  - **Idempotent gateway boot**: `serve` now preflights the `/health` endpoint before binding. If a healthy daemon already owns the port, exits cleanly with exit-0. If bind races, re-probes on EADDRINUSE and defers to the winner.
  - **Rate-limited reconnect logging**: New `createReconnectLogGate` (exported from `@agentproto/runtime`) rate-limits failure logging per key. A dead peer's standing reconnect loop logs the first failure immediately, then at most one line per window with a suppressed-count suffix. Fixes log spam: one dead pairing previously buried 85% of `daemon.log`.
  - **Test coverage**: New comprehensive tests for daemon lifecycle (`daemon-lifecycle.test.ts`), idempotent boot (`serve-idempotent-boot.test.ts`), and log rate-limiting (`reconnect-log-gate.test.ts`).

- 1470be9: Fix billing-auth re-resolution for lazy in-place session resume. Previously, lazy resume called `startSession` with no auth, causing sessions pinned to subscription billing to silently use the daemon's ambient `ANTHROPIC_API_KEY` instead of re-resolving credentials fresh from config. Extracts shared `resolveResumeAuth` function used by both restart and lazy resume paths to ensure consistent fail-loud behavior. Exports `resolveResumeAuth`, `ResumeAuthResolution`, and `ResolveResumeAuthOptions` for external use.
- 6ff5175: Implement interrupted-turn contract (§4) for daemon-restart session recovery. Sessions that die with a turn in flight are now marked with a derived `interrupted` field and resumed without auto-retrying the dropped prompt. A new `SessionResumedEvent` bus event surfaces recovery state to watchers, and a new `isResumable()` predicate gates in-place resumption eligibility. Also fixes an ordering regression (§5) where completion policies were silently cancelled at boot when their watched session recovered under a daemon restart.
- 9d56fa2: Add resume attempt cap and backoff mechanism to prevent infinite retry loops when an adapter consistently fails to resume a session. Introduces `MAX_RESUME_ATTEMPTS` constant, `canResume()` function for cap-aware eligibility checking, and `ResumeDisabledError` exception. Session resume attempts are persisted across daemon restarts and reset on successful completion, ensuring the cap survives crash-loops and prevents exhaustion of resources.
- 9b1736d: Add opt-in eager resume-on-boot for session survivability (PR-4). After a daemon restart, eligible agent-cli sessions are eagerly re-spawned without waiting for a prompt, restoring liveness to orchestrated fleets and completion policies. Feature is off by default (set `daemon.resumeSessionsOnBoot: true` to enable) and includes proper concurrency control and cross-process safety for multi-daemon deployments.
- 47dae30: Implement idle agent-session reaper (PR-6): periodically retire long-idle agent-cli sessions to free adapter processes and prevent resume-storms on daemon restart. New public API exports `runIdleReapPass`, `IdleReapSummary`, and `IdleReaperRegistry` for library users; opt-in via `daemon.idleReapAfterMs` config field or `AGENTPROTO_IDLE_REAP_AFTER_MS` env var.
- 05f85ac: Add "Save as Favorite" functionality to capture and reuse preferred spawn configurations. New HTTP routes (POST/DELETE /user-presets) enable favorites authoring from VS Code, storing user presets with pinned spawn axes (adapter, model, route, effort, context) and location (cwd, skills) in ~/.agentproto/presets.json. Favorites are displayed in the spawn picker with star icon, enabling zero-input re-spawn with their pinned values.
- 8d20b7e: Dynamic session activity line: secondary, auto-regenerating label showing what each session is doing now. Regenerated on turn-end from heuristics (ANSI-stripped last assistant/tool line + lifecycle state); frozen for human-renamed sessions; throttled to ≥60s interval. Displayed as the leading segment of the sessions tree row (sidebar-truncated to 72 chars) and in full in the tooltip.
- 242df33: Add `agentproto sessions gc` CLI command and `POST /sessions/gc` HTTP endpoint for bulk garbage collection of terminal-status sessions. Supports `--older-than-days` (cutoff filter), `--forget` (permanent deletion vs. reversible archival), and `--json` (scripting output).
- 3865de6: Add file-based ("external") subscription login support for Codex and future adapters (Gemini). File-based subscriptions have the CLI read its own login file (~/.codex/auth.json), so the daemon injects NOTHING and only scrubs conflicting api-key environment variables, maintaining the money-safety invariant that no OAuth bearer is ever written to an api-key channel.

  Includes:
  - New `authSubscription: { external: true }` shape in adapter manifests for CLI-resident login files
  - `verifyLocalLoginPresent()` function to fail-loud on missing external login before spawn
  - Comprehensive test coverage for both profile-based and config-based spawn paths
  - VSCode UI integration for "Use my existing Codex login" option
  - Documentation explaining both bearer-injection (Claude Code) and file-based (Codex/Gemini) shapes

- 4d200a9: Implement AIP-41 routine runtime bridge: tight schema for `target` union (tool/agent/workflow/action), `RoutineRegistrar` that reads `.routines/*/ROUTINE.md` and registers cron jobs, `dispatchTool` gateway for in-process MCP tool calls, HTTP `/routine-defs/:id/trigger` and MCP `routine_trigger` tool (mirrors `cron_run`). New `TargetAgent` sugar kind for agent spawning (ahead of upstream draft). Comprehensive unit + integration tests proving all three target kinds fire through real dispatch mechanism.
- 14d29fe: Implement automatic parent attribution for spawned agents via attach policy layer, fixing the orphan-executor bug. Supervisors spawning executors without orchestrator setup now nest as children instead of appearing as depth-0 roots. Also adds session origin tracking and grouping for UI-friendly "claude-code vs vscode vs cron" views.

  New features:
  - `agent_start.attach` field: control spawn parent attachment (false=independent root, true=force attach, {parent}=explicit pin)
  - `spawn.attach` daemon config: policy mode (always=default, on-request=explicit opt-in only)
  - Session descriptor `origin` field: group roots by source (claude-code, vscode, cron, …)
  - `groupRootsByOrigin()` function: bucket session tree by origin for group-based UX views
  - `AGENTPROTO_SPAWN_ATTACH` env override for attach policy

  All new fields are optional; backward compatible default "always" mode auto-attaches via trusted callerSessionId.

- f3f5e82: Implement WS6: credential discovery scanner + first-run onboarding flow. Adds `auth_discover_credentials` (read-only scan of local credentials), `auth_profile_import` (materialize discovered credentials into profiles), and onboarding wizard. Two security invariants verified: never returns secret values (sentinel test), never throws on malformed source (per-source warn+skip). All five discovery origins supported (Claude Code, Codex, Gemini, env, hermes-config). New optional `origin` field on AuthProfile stamps the import provenance.
- 70bfab0: feat(runtime): expose session-story-panel module in package exports

  feat(vscode): live session-story webview panel with "Open story" command

  Reuses SESSION_STORY_PANEL_HTML from @agentproto/runtime byte-for-byte inside a VS Code webview panel (srcdoc iframe relay pattern). Adds agentproto.openStory command to open any session's live timeline, wired into the spawn wizard and session tree context menu.

  The panel drives itself over JSON-RPC 2.0 postMessage, calling session_list/agent_export/agent_prompt via StoryPanelController — a testable bridge mapping the panel's three tools onto DaemonClient.

- f3f5e82: Add profile enable/disable (WS2), per-model curation (WS3), and server-side credential identity display (WS5) features.

  **WS2 — Whole-profile disable**: New `disabled?: boolean` field on `AuthProfile` and `setAuthProfileEnabled()` function enable/disable a profile entirely, dropping all its models to non-runnable. The `eligibleProfiles()` predicate skips disabled profiles at the endpoint/method gate.

  **WS3 — Per-model curation**: New `models?: ModelCuration` field on `AuthProfile` and `setAuthProfileModels()` function restrict a profile to specific models via an allow-list. Curated profiles stay endpoint-eligible but only their chosen refs become runnable. The curation filter is applied downstream in the catalog join.

  **WS5 — Credential identity**: New `credentialIdentity()` function computes a read-only identity (fingerprint + last4 tail) server-side from the keychain, never exposing the secret. `auth_profile_list` MCP tool output now includes key status (`stored` / `self-refreshing` / `unavailable`) and identity for stored secrets. VS Code UI displays the tail and fingerprint in the profile row.

  All changes maintain backward compatibility: absent `disabled` means enabled; absent `models` means mode "all". Profiles without these fields parse and round-trip byte-identically to pre-feature versions.

- babc42d: Add usage rollup feature for tracking spend estimates over rolling windows.
  - New `usage_rollup` MCP tool and `GET /usage/rollup` REST route for querying spend by profile, model, and harness
  - New CLI command `agentproto usage rollup` for local-derived, provider-agnostic spend estimates
  - Pure rollup logic (`parseWindow`, `rollupUsage`) correctly handles cumulative snapshots and separates priced vs unpriced tokens
  - Supports both shorthand (`5h`, `7d`) and ISO-8601 duration formats (`P7D`, `PT5H`)

- 655b4b6: Add windowed cost-budget caps and opt-in live remaining-quota enrichment for usage rollup
- 281eb5f: usage rollup phase 3 — best-effort remaining account credits (OpenRouter + Moonshot) surfaced on byProfile[].credits
- a88a78b: Fix model routing for multi-vendor gateways (OpenRouter/Requesty) by introducing route-identity suffixes. Add bare-product curation tolerance for existing allowlists on direct routes. Export a new `@agentproto/runtime/catalog-models` subpath for the vscode picker's unroutable-model warning.
- 7e47007: Add machine-readable `timedOut` flag to `ExecuteResult` to distinguish timeout terminations from other SIGTERM events. Includes process-group-aware child termination and helpful stderr guidance when timeouts occur. Requires corresponding updates to `RecordCommandInput` and `CommandLogEntry` to fully propagate the field through command logging.
- 924cbf6: Add upstream credential linking and live testing:
  - **@agentproto/llm-endpoint**: New API for per-upstream credential status (describeUpstreamStatus, collectUpstreamStatuses, testUpstream) and HTTP routes (GET /v1/upstreams, POST /v1/upstreams/:provider/test).
  - **@agentproto/runtime**: New llm-endpoint-links-store for persisting upstream→profile links to ~/.agentproto/llm-endpoint-links.json, and new MCP tools (llm_endpoint_set_upstream_link, llm_endpoint_list_links).
  - **agentproto-vscode**: New "Upstreams" tree grouping with inline test and link actions, profile picker QuickPick, and pending-restart annotations when persisted links haven't been applied yet.

  Users can now map LLM provider upstreams to named auth-profiles (instead of bare env keys), manage those links via MCP, and test them live to verify credentials resolve correctly.

- 91741b3: Add opt-in supervisor crash-notification (crash-detect PR-4): parent sessions can now receive direct in-band `[child-crashed]` notices when their children crash by setting `notifyParentOnCrash: true` at spawn time. Notices are enqueued immediately for idle parents and queued for delivery at the next turn for busy parents, ensuring no interruption of in-flight work. Complements the existing external webhook notification path.
- 4e8640f: Implement restart-scheduler (PR-2 of crash-detect chantier): opt-in automatic restart for agent sessions that crash unexpectedly. Introduces RestartPolicy per-session configuration with exponential backoff and rolling-window crash-loop cap. Event-driven scheduling evaluates policy on session:exited; periodic sweep executes due restarts via in-place resume. Persists state so daemon restart mid-backoff preserves schedule. Includes comprehensive test suite and proper lifecycle integration.
- f3b54ad: Implement harness capability discovery — a new layer that answers "what can this adapter actually DO on this host right now" by discovering credentials, providers, model-discovery mechanisms, endpoint compatibility, and application contracts at runtime. Each adapter optionally exports a `<camelSlug>Capabilities` strategy that parses its native config/creds stores (e.g., `~/.gemini/settings.json`, `~/.hermes/auth.json`) to report live state. Falls back gracefully to a pure manifest projection when no strategy is available or it throws. Never surfaces raw credential values — only presence, fingerprints, and last-4 chars. Exposed via the new `harness_capabilities` MCP tool and `@agentproto/cli`'s `listHarnessCapabilities` function.
- e81ad25: Add `agentproto sandbox attach` — Phase 1 of AIP-36 sandbox reconnect. New CLI verb and runtime primitives (`attachSandbox`, `buildMcpConfigSnippet`, `registerSandboxAttachTool`) for connecting to already-existing sandboxes without tearing them down. Returns durable, token-gated connection descriptors for any MCP client to use directly. Extends `SandboxProvider` with optional `connect()` method for resume-after-pause workflows, and adds token capture from Box's `--private` and e2b's traffic restriction.
- 15abbee: Add `--keep-alive` flag to `agentproto sandbox attach` for always-on rendezvous model. Keeps sandboxes indefinitely awake using provider-specific mechanisms (e.g., Box's `ttlSeconds: null` no-auto-stop) instead of letting the provider's idle/TTL auto-stop reclaim them.
- 33221ac: Add Fix D: best-effort resume-context digest for blank-fallback resume scenarios. When a resume degrades to a fresh spawn (adapter doesn't support resume or its conversation store is missing), the daemon reconstructs a bounded summary from `events.jsonl` and injects it as initial context so the session isn't completely blind. Digest is strictly gated on blank-fallback flags—a successful native or ACP resume never gets double-fed its own context.
- 42f1217: Fix routing and credential injection for gateway-routed adapters (D1-D5)
  - D1: Base URL injection gate — skip gateway baseUrl for derived-from-model adapters (hermes); fail loud when adapter can neither accept baseUrl nor derive its route
  - D2: Wire model form — generalized stripFixedNativeVendor for fixed-provider adapters (codex/openai, codex/gpt-5 not openai/gpt-5)
  - D3: Model-derived provider precedence — adapter-declared modelProviders wins over global catalog routing (pi bills kimi via moonshot, not openrouter)
  - D4: Gateway credential injection — resolveAuthSpec honors adapter-declared gatewayAuth.setEnv instead of preset keyEnv (claude-sdk reads ANTHROPIC_AUTH_TOKEN, not OPENROUTER_API_KEY)
  - D5: LLM endpoint adoption — status report never contradicts (running:false, healthy:true); adopt external healthy endpoints as owner:external with probed model list

  New exports: LlmEndpointStatusReport, stripFixedNativeVendor, routeSelection in AgentAdapterResolver.

- d9b4721: Add provider-agnostic inbound webhook endpoints (`POST /inbound/:slug`) with signature verification for agentpush, telegram, whatsapp, slack, and generic platforms. Includes per-endpoint deduplication, MCP tools for endpoint management (`inbound_endpoint_create`, `inbound_endpoint_list`, `inbound_endpoint_delete`), and comprehensive error handling to prevent webhook provider retry loops.
- 4bdea9f: Add per-model provider and adapter-level route selection to support free-routing adapters. This enables adapters like claude-sdk to offer models across multiple billing gateways while preserving money-safety for fixed-provider and derived-from-model adapters. Includes catalog widening logic to emit gateway routes only for adapters that can reach them, plus UI fanout for independent route choice on launch-menu drill-down.
- bcbb6f0: Resolve session route/model as a single source of truth: `resolveEffectiveRoute`, `modelWithRoute`, and `reconcileModelRoute` replace two disagreeing hand-written resolvers and prevent route/model overrides from describing two different billing endpoints (SPEC risk R2 / §4.4).
- 329ef7a: add PR settlement port to resolve pr activities via forge state
- 3123238: add SessionsRegistry.settlePendingWrites to drain in-flight command-log writes

### Patch Changes

- d94680f: Prevent overlapping cron executions from spawning duplicate agent sessions.
- bb63cf2: Fix Codex native OpenAI launch contract. A fixed-provider adapter (e.g. codex with `provider: "openai"`) matched against its own native gateway preset (`route.gateway: "openai"`) is now treated as a direct route: subscription mode stays eligible, the preset `base_url` is dropped, and no `base_url` option is injected. Non-native gateway presets and custom third-party routes remain unsupported for such adapters and are rejected at spawn time; the Configuration Lab filters them out of the route list.
- 636a01b: Fix Node `Buffer` to `BodyInit` incompatibility in Telegram outbound adapter by converting buffers to `Uint8Array<ArrayBuffer>` before passing them to `fetch()`.
- e9900a2: wire inbound endpoint store into the HTTP inbound route
- bd79483: forward routed auth and provider route to sandbox daemon
- 93e6309: Declare MastraCode's model-derived api-key auth contract and enforce it in catalog/session eligibility.
  - `@agentproto/adapter-mastracode`: adds `modelDerivedApiKey: true` so the runtime knows its direct-route API keys derive from the chosen model; the capability strategy now reports each provider's wire protocol (`apiMode`) and never claims subscription support.
  - `@agentproto/driver-agent-cli`: accepts `modelDerivedApiKey` in the AIP-45 manifest schema.
  - `@agentproto/runtime`: `buildCatalogModels` now includes api-key profiles for adapters that declare `modelDerivedApiKey`, matching `spawnEligibilityManifest`.
  - `agentproto-vscode`: Configuration Lab surfaces the corrected MastraCode eligibility (api-key profiles only; no Anthropic subscription defaults).

- 0a165ee: `agent_start`: surface a "did you mean" advisory when a spawn names an explicit
  `model` slug the local catalog doesn't know but a known id shares its bare
  product (a wrong- or missing-vendor/route prefix, e.g. `deepseek-chat` →
  `deepseek/deepseek-chat`, `moonshot/kimi-k2` → `moonshotai/kimi-k2`). Turns an
  opaque late 404 deep in the provider call into an actionable breadcrumb in the
  spawn response `warnings`. Advisory only — never a reject, so genuinely-new and
  free-form (hermes OpenRouter) slugs still spawn, in step with the money-safety
  guard's never-reject-an-unknown-model rule.
- e433dde: Map xAI pricing-catalog models to both the native `xai` route and the Anthropic-compatible `xai-anthropic` route so stored `xai` and `xai-anthropic` auth profiles resolve models correctly in the catalog. Registers `xai-anthropic` as a built-in custom route and surfaces compatibility rows for every xAI-priced model, fixing the UI showing 0 active / 0 models for these profiles.
- 10f9091: Fix: Gate /mcp endpoint against cross-origin browser drive-by attacks. Malicious web pages could previously fetch http://127.0.0.1:<port>/mcp and drive shell + filesystem tools via the loopback bypass in auth mode "none". Now the endpoint rejects untrusted cross-origin browser requests (identified by the Origin header) unless they present a valid bearer token. Native MCP clients and trusted localhost dev origins remain unaffected.
- 4566930: Security fix: add `guardBrowserOrigin()` to reject untrusted cross-origin browser requests to read routes that leak local session state (/conversations, /events, /workspaces, /worktrees). Also tighten CORS to only expose credentials to allowlisted origins, and redact query strings in logs to prevent token leakage.
- 75c9c90: Harden loopback auth bypass by checking the entire family of proxy forwarding headers (not just X-Forwarded-For), closing a gap where proxies that strip XFF but set X-Real-IP / CF-\* headers could bypass auth. Add explicit warning for unauthenticated passthrough tunnels so the exposure is surfaced to users instead of buried in prose.
- fea103e: Add optional `origin` field to session descriptors to track the source/channel (vscode, codex, cron, etc.) that spawned a session. The field flows through spawn inputs and persists for session lineage visibility in the tree view.
- 190a6ed: Add DNS-rebinding defense to HTTP server. Requests from the loopback interface now require a loopback Host header (127.0.0.1, localhost, or [::1]), preventing DNS-rebinding attacks that point malicious domains at 127.0.0.1 while retaining their own hostname in the HTTP Host header. Complements existing Origin-based CSRF guards with a second layer of protection. The `/health` endpoint remains publicly accessible as a harmless uptime probe.
- e44385b: Stamp origin field on spawns from CLI, cron scheduler, and webhook/inbound watcher to track source channel and improve session lineage visibility. Extends the origin-tracking feature introduced in PR #575.
- 93e21ea: Add Linux bubblewrap (`bwrap`) sandbox backend for the `command_execute` sandbox, implementing phase 3 of the command-sandbox work. The new `buildBwrapArgs()` function constructs bubblewrap confinement arguments using an allowlist-by-construction pattern: only bound paths are visible, system dirs are read-only, the workspace is read-write, and strict mode isolates the network namespace. `resolveCommandSandbox()` now returns the bwrap backend when bubblewrap is installed on Linux, falling back to null elsewhere. Includes comprehensive unit and end-to-end tests with platform-specific skips.
- 64db0fb: Fix catalog eligibility parity with the spawn wallet guard (SPEC §1c). `buildCatalogModels` now gates gateway-only models on direct (fixed-wallet) vendor routes, preventing 500 errors at spawn time when the model's actual serviceable routes differ from the route's billed wallet.
- 8a76cc9: Fix: `session_list` MCP tool and `GET /sessions` HTTP endpoint now exclude shell-command runs (`kind:"command"`) from the default view, since commands are execution logs—not resumable sessions—and were cluttering the UI. Commands remain fully accessible via explicit `kind:"command"` filter or `includeCommands:true` parameter (HTTP endpoint and MCP tool). Internal UI panels (sessions/agents-overview/bureau/session-story) now filter to live-able sessions only, matching the new default semantics.
- 7b0d7e7: Harden command sandbox security: implement fail-closed validation when a confinement mode is explicitly configured but the platform lacks the required backend (sandbox-exec on macOS or bwrap on Linux), and add loud per-call warnings when commands run unconfined. Add `AGENTPROTO_COMMAND_SANDBOX_MODE` environment variable to override workspace config without editing tracked files.
- 23c5d28: Forward `resolveSandboxProvider` to scoped orchestrator gateway, fixing regression where children spawned through the orchestrator sub-gateway couldn't resolve sandbox providers even though the daemon had one.
- 4dbd028: Fix flaky startFromFile test by rooting fixtures inside project instead of OS temp dir, ensuring vitest's module resolver keeps imports deterministic.
- c506d87: Extract OS-level process confinement (macOS Seatbelt / Linux bubblewrap) into shared `@agentproto/command-sandbox` package to resolve circular dependency, enabling both `command_execute` tool and adapter child processes to use identical backends. Add `extraWritePaths` support for write-capable directories (e.g., toolchain self-managed installs), and empirically-validated metadata-only `$HOME` allow for npm/npx compatibility. Apply confinement to agent-cli spawns in both ACP/MCP and print-protocol arms.
- dfe8023: Enhance session title handling with clear precedence (explicit title > label > derived) and extend MAX_LENGTH from 60 to 72 code points. Labels are now used verbatim when present, preventing boilerplate orchestrator prompts from creating useless titles—critical for agent spawns where caller intent lives in the label.
- 7f28982: Reject explicit worktree requests on nested spawns (depth > 0) to prevent silent data corruption. A nested spawn that passes an explicit `worktree: true` or `{slug}` request now fails loudly with a clear error message, pointing users to the `sandbox` pattern for isolated nested spawns. Implicit requests (no field or `false`) continue to silently spawn in-place as before, respecting the parent's working tree per AIP-46 §Delegation.
- 3f3333a: Add warning system for nested spawns into shared dirty working trees. Nested agent spawns that run implicitly in-place (no explicit `worktree` or `sandbox` request) now emit a non-fatal advisory warning when the inherited cwd is a shared, dirty git checkout. The warning is silenceable via the new `allowSharedCwd: true` parameter on both the MCP `agent_start` tool and HTTP `/sessions/agent` endpoint.

  Changes:
  - New `allowSharedCwd` parameter on `SpawnAgentSessionInput` (MCP + HTTP)
  - New `warnings?: string[]` field on successful spawn results
  - New `isSharedDirtyCwd()` function to detect shared dirty trees (skipped for daemon-provisioned worktrees)
  - `WorktreeDecision` now carries optional `warn` field for non-fatal notices
  - Comprehensive tests: dirty vs clean cwd, with/without `allowSharedCwd`, root vs nested, all three isolation modes

  Addresses remaining footgun after PR #622's explicit-worktree-at-depth rejection.

- 7465b6c: Harden git-spawn PATH and worktree-cwd anchoring to fix two runtime bugs surfaced by worktree-gc daemon cron. Narrow inherited PATH (frozen at daemon install time) is merged with standard system bin dirs to prevent spawned tools like git from ENOENT-ing. Worktree-specific git spawns are anchored to stable repoRoot instead of per-worktree paths to prevent TOCTOU race conditions where concurrent gc reaps cause misleading "spawn git ENOENT" errors.
- 2ef3bd1: Add native `@agentproto/adapter-gemini` AIP-45 adapter for Google's Gemini CLI in ACP mode, with file-based subscription auth ("use my existing Gemini login" via ~/.gemini/oauth_creds.json). Includes comprehensive spawn and auth resolution tests, VSCode profile flow integration, and catalog entry.
- 5becedc: Add `routine_reconcile` verb and HTTP route for on-demand re-scan of routine definitions. Tighten `schedule` schema from `z.any()` to validated discriminatedUnion with cron/interval/calendar/manual/event kinds, improving type safety and validation coverage.
- 23fa73e: Wire daemon tool-step registry into compileWorkflow; dogfood worktree-gc→notify
- 1cbb910: Remove deprecated RoutineRunner aliases and workflow shim (Phase B3 cleanup).

  The imperative RoutineRunner engine was removed in Phase B2; this PR eliminates the 4 deprecated MCP verbs (`routine_start`, `routine_status`, `routine_cancel`, `routine_escalation_resolve`), their HTTP run routes, and the thin `routine-workflow-shim.ts` that backed them. Preserves AIP-41 routine tools (`routine_list`, `routine_trigger`, `routine_reconcile`) and the `GET /routines` registrar listing route.

- 358af0e: Fix first-party models incorrectly marked ineligible on vendor routes due to router pricing-key collisions. Introduce `resolvePricingExact` to avoid substring-matching false positives (e.g., `google/gemini-2.5-flash-image` → `gemini-2.5-flash`). Restore vendor route for `anthropic/claude-sonnet-5` and `anthropic/claude-fable-5` on direct Anthropic auth.
- 2627fe1: Add daemon-supervised sidecar manager for the @agentproto/llm-endpoint proxy. Implements LlmEndpointRegistry for full lifecycle management (start/stop/status) with concurrency-safe dedup, idempotency, health probing, and MCP tool bindings. Fixes concurrent-spawn orphan leak (Fix 1) and improves crash error visibility with log tail (Fix 2).
- f1484a4: Add `stripRouteSuffix()` utility to strip catalog @route suffix before passing model IDs to upstream providers, and fix llm-endpoint keyEnv from LLM_ENDPOINT_API_KEY to LLM_ENDPOINT_ACCESS_TOKENS.
- 0f10338: Add built-in custom route for local llm-endpoint Anthropic-compatible proxy. The runtime now registers the llm-endpoint route at daemon boot, allowing curated model references (e.g., moonshot/kimi-k2.7-code@llm-endpoint) to transparently route through the local proxy. Configuration is derived from the gateway preset to ensure single source of truth.
- 04f495f: Add `keepAlive` flag to allow sessions to opt out of idle-reaper auto-retirement. Sessions with `keepAlive: true` are never reaped regardless of idle time, useful for supervisors that legitimately park waiting on children or scheduled wakes. Configurable at spawn time via `agent_start`'s `keepAlive` parameter or toggled later with the new `session_set_keepalive` MCP tool. Persists across daemon restarts.
- 469bc47: Fix TypeScript type-checking errors: resolve `vi.spyOn` generic type incompatibility in crash-reaper.test.ts via structural typing, and make `crashDetectIntervalMs` optional in RegisterDaemonHealthToolsOptions for backwards compatibility with code predating this configuration knob.
- 9de8157: Add Box sandbox provider for ascii.dev Box cloud computers. The provider boots a Box, installs an always-on systemd unit for the agentproto daemon, and exposes the daemon's MCP endpoint via a stable hostname. Includes comprehensive test coverage for boot, connect, pause, and stop lifecycles.
- 511ce04: Add push-ingress (`POST /inbound`) and transmitter binding store for bidirectional contact routing. Introduces `inbound-router` shared logic for both poll and push ingress, `transmit_message` MCP tool for sending messages via imported agentpush aliases, and persistent bindings to route inbound replies into sessions. Modes: "spawn" (always new), "route" (bound sessions only), "route-or-spawn" (bound sessions or fallback spawn).
- 40d6a42: Implement resume-honesty fix (AIP-45 resumable capability): prevent silently presenting blank sessions as continuations. When adapters declare `capabilities.resumable: false` (e.g. hermes, mastra-agent), the restart path now gates all ACP-level resume attempts, substituting honest "fresh — resume not supported by X" labels and emitting `contextRestored: false` event flags. Lazy-revived unresumable sessions now get clear banners to prevent confusion with actual continuity.
- ec5f64f: Fix model ID routing for Anthropic-native adapters: reduce direct-anthropic refs (e.g., `anthropic/claude-sonnet-4-5`) to bare product IDs that the native Anthropic wire expects, while preserving vendor/product for gateway-routed models and non-Anthropic adapters.
- 3088e23: Test coverage: prove OpenRouter gpt-5.6 series models (luna/sol/terra and their -pro variants) are selectable in the VS Code picker and launchable through an OpenRouter api-key profile, with money-safety spawn guard validation.
- b373165: Fix race condition in resume-context-injection that caused CI flakes. Move digest building before banner writes to `events.jsonl` so the read doesn't race against asynchronous flush of transcriptWriter.recordEvent.
- 2f246ba: Add Telegram bot support to transmitter system via new provider-agnostic outbound abstraction. Includes telegram-bot-creds store with MCP tools (telegram_bot_token_set, telegram_bot_token_status, telegram_bot_set_webhook) for secure bot token management, telegram-proxy HTTP reverse proxy for webhook ingress, and sendOutbound dispatch supporting agentpush and Telegram. Updated transmit_message tool to accept provider parameter (defaults to agentpush for backward compatibility). Added comprehensive test coverage for security (path traversal, method validation), credential storage, and integration.
- f1b9828: Fix telegram inbound source to use channel name instead of chat ID, preventing binding lookup failures. Also skip disk read when persist is disabled to avoid test isolation issues.
- 29042ca: Generate OpenCode model menu from shared provider catalog; add model-derived API key auth support and router-prefixed model ID handling across runtime and VS Code configuration UI.
- cce3546: ## Progressive Sessions Webview Loading

  Introduces a new `GET /sessions/summaries` endpoint on the runtime that returns lightweight `SessionSummary` projections with pagination support. The VS Code Sessions webview now uses this endpoint to load the first page (50 summaries) instantly, then offers a "Load more" affordance for older sessions, improving first-paint performance when the daemon holds hundreds of sessions.

  ### Runtime (@agentproto/runtime)
  - Added `SessionSummary` interface — a lightweight projection of `SessionDescriptor` excluding large resume/transcript/policy context
  - Added `listSummaries()` method to `SessionsRegistry` with `limit`/`offset` pagination
  - Added `GET /sessions/summaries` HTTP endpoint

  ### VS Code Extension (agentproto-vscode)
  - Refactored Sessions webview to consume `SessionSummary` instead of full `SessionDescriptor`
  - Implemented progressive loading: bounded first page + "Load more" button
  - Pending optimistic rows merged from store on each render for instant spawn feedback
  - Intelligent refresh: re-fetches the currently loaded slice on SessionStore changes
  - Removed workspace dropdown filter (simplification for paginated model)

  ### Sandbox Box (@agentproto/sandbox-box)
  - Fixed flaky test: strip ANSI color codes from stdout when `FORCE_COLOR=1` is set

- 04aedad: Weekly dependency bump with semver-safe minor/patch updates across 18 packages. Includes Mastra ecosystem update (1.31-1.48.x → 1.52.1), Claude SDK patch (0.3.200 → 0.3.220), build tool updates (turbo, tsx), and general dependency maintenance (yaml, ws, react, etc.). All changes verified to pass build, test, and type checks.
- 77e93e5: synthesize tool-result for orphaned pending tool calls at turn-end
- 4832ced: Terminal restart fidelity: route-aware launch config, native terminal resume capability, and resume honesty.
  - Extracts `buildRouteAwareLaunchConfig` so fresh spawn and restart inject `base_url` identically; derived-from-model adapters (e.g. hermes) no longer receive an unsupported `options.base_url`.
  - Adds `capabilities.nativeTerminalResume` to the agent-cli manifest schema and stamps it on session descriptors; `pty-native` restart is now an explicit capability, not implied by ACP resumability.
  - Preserves auth profile, route, model, posture, effort, and effective environment across restarts; wire model strips catalog `@route` suffixes and fixed-provider native vendor prefixes.
  - Resume-honesty fix: adapters declaring `resumable: false` degrade to a flagged fresh spawn instead of a phantom ACP resume.

- b3e1648: Fix a false-green where an un-authenticated agent turn reported success. The ACP client mapped any non-`cancelled`/`max_turns` `stopReason` — including `refusal`, which claude-sdk returns after a 401 auth failure — to a `completed` turn-end. Because the adapter also emits a `[claude-sdk error]` chunk, the turn is not empty, so the existing empty-turn guard missed it and the workflow step reported `done`. The ACP client now maps `refusal` and any unknown/missing `stopReason` to `reason: "error"` — while routing the budget-cap reasons (`max_tokens`, `max_turn_requests`) to the non-failing `max_turns` bucket so a legitimate long turn isn't misfired as an error — and the workflow agent-host fails a step whose turn ends with `reason: "error"` (not only empty turns), so an auth-failed reviewer run reports `failed` and falls back instead of passing blind.
- bd79483: test(runtime): settle pending writes before workspace teardown
- Updated dependencies [c736c02]
- Updated dependencies [8367648]
- Updated dependencies [013e7b3]
- Updated dependencies [8367648]
- Updated dependencies [93e6309]
- Updated dependencies [831d4f5]
- Updated dependencies [6ff42b4]
- Updated dependencies [645279d]
- Updated dependencies [5ba2032]
- Updated dependencies [c506d87]
- Updated dependencies [392021a]
- Updated dependencies [3865de6]
- Updated dependencies [4d200a9]
- Updated dependencies [f3f5e82]
- Updated dependencies [5becedc]
- Updated dependencies [5643cb6]
- Updated dependencies [23fa73e]
- Updated dependencies [655b4b6]
- Updated dependencies [1cbb910]
- Updated dependencies [358af0e]
- Updated dependencies [f1484a4]
- Updated dependencies [0f10338]
- Updated dependencies [f3b54ad]
- Updated dependencies [e81ad25]
- Updated dependencies [15abbee]
- Updated dependencies [ec5f64f]
- Updated dependencies [1ea7682]
- Updated dependencies [42f1217]
- Updated dependencies [4542ca3]
- Updated dependencies [c064bc7]
- Updated dependencies [68ef7fb]
- Updated dependencies [4832ced]
- Updated dependencies [b3e1648]
  - @agentproto/provider-presets@0.5.0
  - @agentproto/driver-agent-cli@2.1.0
  - @agentproto/sandbox@0.2.0
  - @agentproto/auth@1.0.0
  - @agentproto/driver@0.2.0
  - @agentproto/acp@0.7.0
  - @agentproto/command-sandbox@0.2.0
  - @agentproto/routine@0.2.0
  - @agentproto/mcp-server@0.2.4
  - @agentproto/workflow-runtime@0.6.0
  - @agentproto/workflow@0.1.1
  - @agentproto/model-catalog@0.7.0
  - @agentproto/provider-kit@0.4.0
  - @agentproto/secrets@0.2.2
  - @agentproto/workflow-loader@0.1.2
  - @agentproto/providers-store@0.3.2
  - @agentproto/eval-reporters@0.2.4
  - @agentproto/telemetry-langfuse@0.2.3

## 1.1.0

### Minor Changes

- ed0c269: Add terminal input endpoint and UI toggle for conversation/terminal view switching.
  - HTTP endpoint `POST /sessions/:id/terminal/input` for writing raw input to PTY sessions (FIX 2)
  - DaemonClient method `writeTerminalInput` for terminal input requests
  - VSCode UI: Conversation⇄Terminal segmented toggle for sessions with both representations
  - Routing: Terminal sessions now use `writeTerminalInput` instead of `prompt` endpoint
  - View toggle logic for agent-cli and native-conversation PTY sessions

- 4632ec7: Session management feature set: terminal input routing via POST /sessions/:id/terminal/input, session renaming via PATCH /sessions/:id and session_rename MCP tool, explicit --title flag for spawn, and structured↔terminal view toggle for dual-representation sessions. Includes code-point-aware name truncation, field-independent rename operations, and comprehensive test coverage.

### Patch Changes

- ee4ab3f: Fix linked git worktree session workspace resolution: sessions spawned in linked worktrees now group under their base repo's registered workspace instead of falling back to "default". Also adds symlink-aware path comparison to handle macOS `/tmp` → `/private/tmp` aliases.
- a4239ff: Repair two `WorkspaceEntry` test literals that predated the AIP-34
  `addedAt`/`updatedAt` fields becoming required, restoring `check-types` green.
- Updated dependencies [3edb7a7]
- Updated dependencies [a0b94fd]
- Updated dependencies [cc00682]
  - @agentproto/workflow-loader@0.1.1
  - @agentproto/auth@0.2.0
  - @agentproto/driver-agent-cli@2.0.1
  - @agentproto/secrets@0.2.1
  - @agentproto/acp@0.6.0
  - @agentproto/sandbox@0.1.5

## 1.0.0

### Major Changes

- 8e99f17: Fix session-bucket clobber on registry-read failure or skewed reload; readRegisteredSlugs now returns {slugs, ok}

### Minor Changes

- cc84da6: Fix claude-code project-slug encoding and add persisted conversation index + `conversation locate` verb
- 40cd699: Add archivable terminal sessions: session_archive/session_unarchive MCP tools + list({includeArchived})
- b16bb83: Add SessionConfig axes type + decomposeMode/composeMode shim (SPEC §3.1)
- b331539: Add read-only GET /catalog/models + catalog_models MCP tool (SPEC §5)
- 40036de: Add canonical-posture layer (native mode resolution + prompt-injection fallback)
- 7441a7d: Add descriptor config-axis echo fields (effort/posture/route/contextProfile/accessProfile) + AuthMethod export
- 57d1499: Route sandboxed agent-step spawns through spawnAgentSession; e2b installPackages boot option
- d4d515e: Add axis-generic session:config-changed event, emitted from setModel alongside session:model-changed
- 48c55d5: Add live effort + live posture verbs and a model↔route switch guard
- 39ace5f: Add restart-with-override: axis overrides on session_restart + POST /sessions/:id/restart

### Patch Changes

- 1411e36: Don't engage native Anthropic billing-auth when a gateway base_url is set without an auth_token
- 6453ff6: Persist session_restart's resumedFrom/resumeVia on the stored descriptor
- 336c49c: Expose real agent-step ids/session ids in file-based workflow runs and fail a step on an empty (no-op) turn
- 92c1c51: Narrow AgentCliMode.kind to "context"; drop posture/route modes from claude-code, codex, opencode
- c3bfaea: Fix catalog_models 500 on router-prefixed OpenRouter model ids
- 3d403d7: Fix e2b sandbox timeout issues and add poll resilience.

  Root cause: e2b's per-command timeout defaults to 60s (even for `background: true` commands), killing the daemon mid-turn; sandbox lifetime defaults to 5min, reaped during long turns. Native reviewer failed on every PR, triggering fallback double-reviews.

  Changes:
  - **harness**: Increase MCP request timeout to long-poll window + 60s grace (client was aborting at 60s while server held 49s windows, leaving ~11s headroom)
  - **runtime**: Add poll resilience — retries transient failures up to 6x; make output pulls best-effort (offset-diff safe)
  - **sandbox-e2b**: Set `timeoutMs: 0` on serve command (disables per-command timeout); default sandbox lifetime to 45min (overridable); re-arm timeout on reconnect
  - **ci**: Add postcheck gate (prevent duplicate reviews when native lane posts then errors post-post); add verify gate (confirm review row exists on GitHub API); integrate Langfuse tracing (soft-fail when creds absent)

- Updated dependencies [9e30ad2]
- Updated dependencies [5c99163]
- Updated dependencies [1411e36]
- Updated dependencies [b16bb83]
- Updated dependencies [a021138]
- Updated dependencies [9fab1ad]
- Updated dependencies [92c1c51]
- Updated dependencies [57d1499]
- Updated dependencies [48c55d5]
- Updated dependencies [e3bacf3]
  - @agentproto/model-catalog@0.6.0
  - @agentproto/provider-presets@0.4.1
  - @agentproto/driver-agent-cli@2.0.0
  - @agentproto/acp@0.6.0
  - @agentproto/workflow-runtime@0.5.0
  - @agentproto/mcp-server@0.2.3
  - @agentproto/providers-store@0.3.1
  - @agentproto/sandbox@0.1.4
  - @agentproto/eval-reporters@0.2.3
  - @agentproto/telemetry-langfuse@0.2.2

## 0.8.0

### Minor Changes

- a4d091d: Add policy-driven git-worktree isolation on agent_start
- 2f8ba2d: Stop misdirecting zero-credential agent-cli users to buy a subscription

### Patch Changes

- f392877: Sync docs with latest release features (interrupt, conversation_read, WORKTREE column, llm:context-windows, duration flags)
- 9c2cec0: Add Requesty gateway preset and fix openrouter's double-/v1 base URL bug
- Updated dependencies [719771e]
- Updated dependencies [9c2cec0]
- Updated dependencies [9c2cec0]
- Updated dependencies [2f8ba2d]
  - @agentproto/model-catalog@0.5.0
  - @agentproto/providers-store@0.3.0
  - @agentproto/provider-presets@0.4.0
  - @agentproto/provider-kit@0.3.0
  - @agentproto/sandbox@0.1.3
  - @agentproto/eval-reporters@0.2.2

## 0.7.0

### Minor Changes

- 0d74b1e: Add SessionDescriptor.title derived from first prompt text
- 8aec010: Add ConversationStore abstraction, hermes attach support, and conversation_read MCP verb
- e5d55a7: Record worktreePath and worktreeId on SessionDescriptor at spawn time
- 8778b9d: Add optional sessionId filter to policy_list, GET /policies, and policy ls
- 98bbebf: Partition session state per workspace (AIP-46 §State partitioning)
- bbc5070: Add interruptSession registry method, POST /sessions/:id/interrupt route, and agent_interrupt MCP verb

### Patch Changes

- 7b80d00: Add last-known-good fallback so a rebuilding adapter isn't reported as uninstalled
- a571bf9: Fix flaky command-log tests by polling instead of a fixed 20ms sleep
- 45ee7ef: Stop test gateways persisting fake session rows into the real ~/.agentproto/
- 5d2b869: Redact client slug from fixtures and drop machine-specific comment framing
- e0b4b85: Widen interrupt-settle timeout to 60s to avoid false timeouts on slow adapters
- Updated dependencies [b531fd1]
  - @agentproto/model-catalog@0.4.0
  - @agentproto/providers-store@0.2.1
  - @agentproto/sandbox@0.1.2

## 0.6.0

### Minor Changes

- 1bdc055: Add xAI provider support and session options passthrough (base-url/auth-token/options-json)
- ed52691: Surface empty (zero-output, zero-tool) turns with empty:true on session:turn-end
- 7b6c8d0: Add daemon.authToken config field and --auth-token flag for persistent gateway bearer token
- 049c2fe: Add generic ACP agent support: curated catalog, config-defined agents, acp verb
- 0ea6fc1: Add cross-session permission-hold inbox: permissions ls|approve|deny, MCP tools, REST routes
- 386a573: Add deterministic auth spawn mode (subscription vs api-key) for claude-code
- c036f59: Explicit credential selection + verifiable auth mode for claude-code spawns
- 60792f1: Add E2E daemon pairing: rendezvous broker, pair CLI, daemon registry
- d425044: Add catalog-sourced billing-credential resolver for all adapters
- 6894d2e: Add named terminal presets via terminalPresets in config.json
- 6aafd13: Auto-detect workspace from cwd when no workspaceSlug is provided
- 3639abd: Default pair offer to the hosted rendezvous broker when nothing is configured
- ed241b8: Add GET /sessions/:id/events/stream SSE endpoint with exactly-once replay→live handoff
- a63b4bc: Add worktree new verb, worktrees.root config, and provision provenance marker
- eec7b5d: Add opt-in idempotencyKey to agent_start for retry-safe process spawning
- ea44602: Add sessions story subcommand and expose runtime/session-story subpath export

### Patch Changes

- 410271d: Accept `id` alias on drive tools; coalesce session_monitor arg shapes
- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- 8a4d5d5: Add opt-in E2E encryption for the serve --connect tunnel (tunnel-e2e/v1)
- af7ab1f: Fix transcript-writer seq collision after daemon restart; add structured VS Code conversation rendering
- 031735e: Fix workspaceSlug derivation from cwd on terminal and raw spawn paths
- 33f5fa4: Fix sendPrompt silently dropping interrupt on the blocking prompt arm
- 769f75f: Re-resolve billing auth on session_restart to prevent silent credential fallback
- d85e129: Clear frozen in-flight flags on already-terminal ghosts at snapshot load
- 475249b: Clear frozen in-flight flags on forced session termination (daemon-restart path)
- 8e7353a: Extract providers-store into a leaf package; fix llm-endpoint boot to inject stored provider keys
- 40fb9e8: Reject out-of-window contextUsed values instead of surfacing impossible occupancy figures
- a32bb69: Bump test timeouts on subprocess/IO-heavy tests that flake under parallel load
- 1549bdd: Close read-path gap for stale out-of-window contextUsed (#364 follow-up)
- ff4617c: Fix blockedOn latching when a tool fails (error event now releases it)
- c8198c6: Fix dropped tool-call arguments from non-terminal ACP tool_call_update frames
- Updated dependencies [1b282ab]
- Updated dependencies [1bdc055]
- Updated dependencies [afbf5c4]
- Updated dependencies [7b53b8c]
- Updated dependencies [0ea6fc1]
- Updated dependencies [6d4aa4b]
- Updated dependencies [60792f1]
- Updated dependencies [8a4d5d5]
- Updated dependencies [d425044]
- Updated dependencies [c430b9f]
- Updated dependencies [d924e95]
- Updated dependencies [94a7e90]
- Updated dependencies [3639abd]
- Updated dependencies [8e7353a]
- Updated dependencies [a32bb69]
- Updated dependencies [e0fbccc]
- Updated dependencies [c8198c6]
  - @agentproto/provider-presets@0.3.0
  - @agentproto/model-catalog@0.3.0
  - @agentproto/acp@0.5.0
  - @agentproto/agent@0.2.1
  - @agentproto/eval-reporters@0.2.1
  - @agentproto/manifest@0.2.1
  - @agentproto/mcp-server@0.2.2
  - @agentproto/provider-kit@0.2.1
  - @agentproto/redaction@0.2.1
  - @agentproto/sandbox@0.1.1
  - @agentproto/secrets@0.2.0
  - @agentproto/telemetry-langfuse@0.2.1
  - @agentproto/workflow-loader@0.1.0
  - @agentproto/workflow-runtime@0.4.0
  - @agentproto/workflow@0.1.0
  - @agentproto/providers-store@0.2.0

## 0.5.0

### Minor Changes

- 6b8b023: Add bin_args_prepend, plumb options map, and declare lean modes on agent-CLI adapters
- 99a5c60: Add agentproto_session_story MCP app — per-session story panel with buildStory heuristic
- 80ca385: Add per-session usage observability: cost + tokens, live via MCP + durable
- 7142f1c: Add per-mode support status (active|noop|planned) to AIP-45 agent-CLI manifest
- 7f1584d: surface blockedOn (subagent|command) on SessionDescriptor
- af10521: add display-mode toggle (fullscreen/pip) to all ui:// panel bridges
- 517fe8c: Add agentproto_terminal MCP App: live PTY over WebSocket with CSP connectDomains
- e231d80: Add spawn-time role profiles (executor/supervisor) with hard delegation-tool gate
- 7ba7e06: expose eval-reporter MCP tools on the daemon gateway
- ec70cda: Add interrupt flag to agent_prompt for soft Ctrl-C mid-turn redirect
- 4b93900: Add role registry, privilege-lattice spawn gate, and role_list MCP tool
- e73dae1: Add enter and b64 options to terminal_input for reliable TUI key submission
- a7ccd54: Add langfuseSessionTracer and extract shared createIngestionClient with atomic-drain flush
- 2d23f82: Add filterSessionObserver and opt-in Langfuse tracing per session
- 1813814: Add command_execute JSONL audit log and command_log_tail MCP tool
- b3921a9: Add WorkflowRunner.startFromFile and workflow_run_file MCP tool
- fdb8ea1: Add credentialRef + headers to AcpMcpServer for brokered child-MCP auth at spawn time
- 1c69f14: Add sandbox provider family: list_sandbox_providers + setup_sandbox_provider MCP tools
- e029a35: Wire agent_start.sandbox: boot box + proxy session via SandboxAgentSessionProxy
- afe2541: Add daemon_health MCP tool for cheap in-process liveness probing
- 553597a: Add sandbox reconnect/reuse and AIP-36 lifecycle pause support
- a28bebc: Add provider-presets catalog listing and AIP-45 presets manifest field
- b588e36: Add a `defaults` block to `~/.agentproto/config.json` — global and per-adapter `skills`/`options` auto-applied to every `agent_start` spawn. A normalized `skills: string[]` is folded into the resolved adapter's native option shape (e.g. hermes' comma-joined `--skills a,b`); adapters with no declared `skills` option are a no-op.

### Patch Changes

- ba74049: Guarantee a terminal turn-end for every agent turn (exited/error/aborted)
- 6c83622: Emit usage_update transcript events for hermes and mastracode adapters
- c4873a2: fix MCP Apps panels: forward resources/\* through mcp-bridge + spec-correct ui/initialize handshake
- 94740f9: Fix session-story panel rendering Markdown as literal text instead of HTML
- 2532d33: Scrub ambient Anthropic key under gateway base_url; provider-driven bearer auth
- e2388e8: fix(tunnel): redirect cloudflared stdio to file to prevent pipe back-pressure wedge
- 665903e: keep agent_output visible during tool-busy turns; never drop tool errors
- 863d6d9: fix(runtime): stop provider default credentialsFile shadowing named tunnel creds
- 48f658c: Extract SessionObserver seam for pluggable per-session transcript taps
- e5389c9: Trust cli.agentproto.sh origin so the panel PTY terminal connects
- 7bb147c: Forward trace flag through POST /sessions/agent HTTP route
- 973b553: terminal_input: send enter CR as isolated write for paste-safe submit
- bd4d7a0: Add value-scan redactor and secrets slug; bump runtime default tracer to secrets
- b77a552: Rename adapter-kit → provider-kit; add adapter-kit@0.2.0 compatibility shim
- 13991da: Harden role dispositions to explicitly prohibit native CLI subagent/Task-tool delegation
- 5747d5f: Trim session-story execute() payload when sessionId is known; add full-panel deep-link
- b1ce54c: De-flake command-log test by returning the write promise instead of a fixed delay
- fad8300: Fix claude-sdk idle watchdog false-abort and frozen ring on long thinking turns
- 16c85e7: Fix cron prompt-session resilience: skip if busy, auto-resume if dead, fix daemon shutdown hang
- 2d6aead: Fix session_restart resuming wrong conversation via fs-probe sibling leak
- 6cc9e25: Dedupe sandbox capability constant, drop redundant author guard + unused token-env export
- 6bbd6cd: Sessions panel: turn-aware status badge for agent-cli sessions. A running agent-cli process now shows `working` (turn in flight), `waiting` (awaiting input), or `idle` (process alive, no turn running) instead of a flat `running`, reading the `busy`/`awaitingInput` descriptor fields.
- Updated dependencies [f8ebe41]
- Updated dependencies [80ca385]
- Updated dependencies [6a5c41c]
- Updated dependencies [7aaf24a]
- Updated dependencies [126f7c6]
- Updated dependencies [aa70df9]
- Updated dependencies [310de1a]
- Updated dependencies [d9726d3]
- Updated dependencies [5b9b5ec]
- Updated dependencies [a7ccd54]
- Updated dependencies [bd4d7a0]
- Updated dependencies [b77a552]
- Updated dependencies [6a0d8fe]
- Updated dependencies [2154ed5]
- Updated dependencies [fdb8ea1]
- Updated dependencies [b65ca15]
- Updated dependencies [e029a35]
- Updated dependencies [553597a]
- Updated dependencies [abb49cf]
- Updated dependencies [34cfcb5]
- Updated dependencies [2adc163]
  - @agentproto/workflow-runtime@0.3.0
  - @agentproto/acp@0.4.0
  - @agentproto/sandbox@0.1.0
  - @agentproto/telemetry-langfuse@0.2.0
  - @agentproto/eval-reporters@0.2.0
  - @agentproto/redaction@0.2.0
  - @agentproto/provider-kit@0.2.0
  - @agentproto/provider-presets@0.2.0

## 0.4.0

### Minor Changes

- 8d1191e: Rename all MCP tool verbs to family-first taxonomy (agent*\*, session*\_, terminal\__, command*\*, file*_, directory\__, browser*\*, policy*_, routine\_\_, tunnel\_\*), split agent tools into a dedicated `agent-tools.ts` module, and fix harness call-sites.
- 16d52cd: Add WorkflowRunner primitive, deferred tool gateway, structured awaiting-input, and agent_start mode wiring
- 17aff95: Add durable cron scheduler with MCP tools, REST routes, and CLI verb
- 5c207ca: Add scriptable session/policy wait — REST endpoints and CLI subcommand
- 83aa850: Add session liveness tracking: pid, lastActivityAt, processAlive on SessionDescriptor
- 872226b: Add per-turn silence watchdog to ACP client to fix hermes hang-without-turn-end
- 5616041: Add session_restart MCP tool and extract shared resume decision tree
- 111a599: Add prompt-session cron action to re-prompt a live session
- 29d9c55: Add REST parity for routines, workflows, and policies HTTP routes
- 4f1565b: Share agent_start spawn logic between MCP tool and HTTP route via spawnAgentSession
- 3ab696d: Render tool calls/results informatively instead of the generic `[tool] view` line
- caab49e: Add AgentStep kind and AgentSessionHost; wire WorkflowRunner onto the interpreter
- 79a209a: Add structured per-session transcript capture and daemon-events export source
- 3cfe18a: Add outputSchema/maxRetries to AgentStep with validate-and-retry loop
- 887ea34: Add run-level cost ceiling (maxTotalCostUsd) and AgentSessionHost.readCostUsd
- 4b76485: Add opt-in journal cache for cacheable steps — replay unchanged outputs on re-invocation
- e27fc94: Add GET /sessions/:id/events for incremental polling; fix mastra tool_start args

### Patch Changes

- f89be1f: Default-mount daemon MCP gateway for hermes agent_start spawns; fix orchestrator merge-line bug
- fb1e5f0: Thread daemonMcpUrl into scoped orchestrator gateway to fix hermes zero-tool spawns
- a648994: Fix processAlive returning undefined from findByIdOrName on live sessions
- 71c52eb: Fix policy_attach gates throwing "cwd escapes workspace" for worktree sessions
- 3812f01: Don't duplicate a salient arg already baked into a curated tool title
- 8ce517b: Fix silent prompt-delivery failures for dead and busy sessions
- 837967a: Fix transcript-writer stripping newlines from text-delta/thought events
- Updated dependencies [83aa850]
- Updated dependencies [872226b]
- Updated dependencies [3ab696d]
- Updated dependencies [caab49e]
- Updated dependencies [79a209a]
- Updated dependencies [3cfe18a]
- Updated dependencies [887ea34]
- Updated dependencies [987db7b]
- Updated dependencies [4b76485]
- Updated dependencies [a5c4701]
  - @agentproto/acp@0.3.0
  - @agentproto/workflow-runtime@0.2.0

## 0.3.0

### Minor Changes

- 7a310ff: Add model-catalog package, provider-key store, and `agentproto models` command

## 0.2.0

### Minor Changes

- ea9be98: Wire the browser CLI verb into the router and register browser MCP tools (start_browser / list_adapter_browsers) in the gateway.
- e33d99a: start_browser no longer blocks the MCP request during a cold start — heavy services (chromium/bureau) register immediately as `starting` and converge to healthy in the background; opt-in via BrowserProcessSpec.initialWaitMs, default behavior unchanged.
- 593b0fc: Wire RoutineRunner into root gateway and persist runs to disk
- 358949b: Expose optional per-session notifyUrl on start_agent_session tool
- 79149d5: Add InboundWatcher — poll agentpush and spawn agents on inbound events
- fc6fd0b: Add session cost/cap, wait:true one-shot, clean output, model echo, wait_for_any cursor
- 250f474: Migrate tunnel providers onto a slug-keyed adapter-kit registry; ngrok now creatable end-to-end; third-party providers pluggable
- dc870cf: tool: toolFromManifestOnly + optional inputSchema/outputSchema; runtime: session lifecycle events on bus + completion-policy supervisor MVP
- 3e348e3: Add WP3 policy persistence: boot reload, re-arm, and session-absent cancellation for CompletionPolicySupervisor
- 5c2063e: Thread mcpServers through spawn to ACP newSession/loadSession; add named Cloudflare tunnel provider
- 0022b2a: Thread mcpServers through spawn to ACP newSession/loadSession (orchestrator WP1)
- a15acc4: Add fan-in completion policy (WP4): attach_policy accepts sessionIds[] for all-of groups
- 618d424: Add orchestrator sub-gateway WP2–WP4: scoped MCP endpoint, scope-token registry, recursion guardrails
- 452b751: Add agents-overview + bureau-sessions MCP App panels and summarize_session tool
- 9cacd25: Add WP6 subtree-scoped supervisor composition for child orchestrators
- 6587000: Honor model and add effort to start_agent_session for claude-code adapter
- 6738ef9: Surface adapter manifest (location/install/config) over MCP; add binPath to start_browser
- ec769ab: Extract daemon helpers, add POST /sessions/browser route, fix stop_browser return shape
- 0d3b8f9: Add @agentproto/adapter-kit and migrate tunnel/browser/CLI adapter families onto it
- 7a89e37: Surface exportAgentSession via export_session MCP tool and sessions export CLI
- 1b8ae4e: Add browser_screenshot MCP tool — base64 frame proxy for live agent-browser view
- e6c9b80: Routine runner, orchestration tools, session event bus, event ring, transcript export.

  Adds `RoutineRunner` for scheduled / event-triggered routine execution, `SessionEventBus` for typed intra-session pub-sub, `EventRing` as a bounded circular buffer for session events, `orchestration-tools` (run-routine, list-routines AIP tools), and `exportTranscript` for full-session transcript serialisation. Also extends `sessions.ts` with `awaitingInput` state and browser-session fields (non-breaking additions).

- 405ea4d: Add MCP Apps adapter and agentproto_sessions panel (AgnoMcpApp)
- cfbeb8f: Browser-as-adapter stack: adapter-browser, browser-process primitive, `agentproto browser` CLI

### Patch Changes

- 0c7ced0: Fix bureau /mcp dispatch: add text/event-stream to Accept header to prevent HTTP 406
- 4277e54: Fix RoutineRunner fast-session race and honour start_routine cwd
- 8e540c3: Update browser session label on idempotent registerBrowser hit
- 7542339: Fix hermes model selection (apply:"command") + wait_for_any fast-turn race
- 43f9c8a: Add central daemon registry so CLI discovers a daemon from any cwd
- c938b78: Fix JSON-stringified union/object MCP params being rejected by zod (cowork client compat)
- 1769728: Fix attach_policy MCP schema to expose judge-gate variant alongside shell gate
- 7fec1bc: Add multi-field makeSetupTool variant; migrate cloudflare-named to SetupField[]
- 979d01a: Make ngrok check() env-independent via injectable probeBinary; fixes CI
- b86264b: fix(browser): HTTP route and registerBrowser cloud/local parity
- Updated dependencies [c6a90e2]
- Updated dependencies [250f474]
- Updated dependencies [4baab31]
- Updated dependencies [6587000]
- Updated dependencies [0d3b8f9]
- Updated dependencies [7fec1bc]
- Updated dependencies [4b2c9ec]
- Updated dependencies [2186e9e]
  - @agentproto/acp@0.2.0
  - @agentproto/adapter-kit@0.1.0
  - @agentproto/mcp-server@0.2.1

## 0.1.1

### Patch Changes

- 1fc1750: Add loadAgent, updateManifestSet, self_inspect MCP tool, and extends-chain validation
- 1fc1750: Add loadAgent, validateExtendsChain, updateManifestSet, and self_inspect MCP tool
- Updated dependencies [1fc1750]
- Updated dependencies [1fc1750]
  - @agentproto/agent@0.2.0
  - @agentproto/manifest@0.2.0
  - @agentproto/mcp-server@0.2.0

## 0.1.0

### Patch Changes

- 44192c9: Add self_inspect MCP tool, extends-chain validation, driver MCP verb, and atomic manifest writes
- Updated dependencies [44192c9]
  - @agentproto/agent@0.1.0
  - @agentproto/manifest@0.1.0
  - @agentproto/mcp-server@0.1.0
