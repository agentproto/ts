# @agentproto/driver-agent-cli

## 2.3.1

### Patch Changes

- 76f2c78: Multi-surface external subscriptions — one adapter can now declare BOTH a Claude and a ChatGPT native OAuth login, so mastracode/opencode's subscription eligibility no longer forces an anthropic-or-openai choice. `authSubscription` accepts a single surface (unchanged) OR an array of surfaces, one per billing provider; two entries claiming the same provider scope (or two unscoped entries) are rejected at manifest-validation time rather than resolved arbitrarily at spawn time. The runtime's old `subscriptionAppliesTo` boolean predicate is replaced by `subscriptionSurfaceFor`, which resolves the MATCHING surface for a spawn's resolved provider — used by `resolveAuthSpec` and the three mirrored direct-methods projections (`session-spawn.ts`, `session-restart-core.ts`, `catalog-models.ts`) so they stay in lockstep. `verifyLocalLoginPresent` now takes an optional provision-recipe `methodId` (convention `<provider>-oauth`) so a multi-surface spawn verifies the RIGHT login file instead of always checking the recipe's default method. mastracode declares both `{external: true, provider: "anthropic"}` and `{external: true, provider: "openai"}` — its ChatGPT login (`openaiCodexOAuthProvider`) is stored in its own auth.json under the key `openai-codex`, verified live. opencode declares the same pair: its ChatGPT OAuth login was reverse-engineered from the shipped binary (no OSS source available for this build) and is keyed under the SAME `openai` provider id its API-key flow already uses — there is no separate "chatgpt" key, confirmed by tracing the binary's generic `Cli.providers.login` → `Auth.set(provider.id, …)` write path. Both adapters' provision recipes gained an `openai-oauth` method alongside the existing `anthropic-oauth` one.
- 64088e0: Refuse to run a derived-from-model adapter on its default model when the requested model was not applied. Launching opencode with an id its server can't resolve (e.g. a claude-code-style `…@openrouter` suffix) used to warn on the daemon's stderr and silently run — and bill — the server's default `anthropic/claude-sonnet-4-5` instead; hermes had the same hole one strategy over (its spawn-time `/model <id>` control turn's result was ignored), and jcode a protocol over (its CLI silently falls back to its own default on an unknown `--model` id — observed live: `--model totally-bogus-xyz` → started on `gpt-5.6-sol`/OpenAI). Three guards now share one contract for `routeSelection:"derived-from-model"` adapters: the ACP client records a connect-time model rejection structurally (`AcpClientSession.modelApplyRejection`) and the driver refuses the spawn on a rejected `set_config_option` (opencode-style `apply:"config"`) or an unacknowledged/failed `/model` control turn (hermes-style `apply:"command"`); the print arm aborts a turn whose jcode-ndjson `start` line reports a model contradicting the requested one (basename compare, `@route`-suffix/`provider/`-prefix tolerant). Every refusal names the requested id and the concrete reason. Free/fixed-routing adapters keep the agentproto#186 warn-and-continue behavior unchanged; pi errors properly on its own (`Model not found`) and needs no guard.
- e3ad769: Claude subscription on pi/opencode/mastracode — each through the door that actually exists — and honest subscription eligibility everywhere. The runtime assumed "Anthropic OATs work as API keys" for every model-derived adapter and silently injected the subscription OAuth token into `ANTHROPIC_API_KEY`, where Anthropic's edge rejects it as an invalid key after the session is live (observed on opencode: "Internal error: API key is invalid"). Subscription support now requires an explicit, provider-matching `authSubscription` surface, shared across all four eligibility/resolution sites via one `subscriptionAppliesTo` predicate. pi declares its documented bearer env (`ANTHROPIC_OAUTH_TOKEN`, scoped `provider: "anthropic"`) so a Claude subscription profile runs pi's anthropic models natively. opencode and mastracode declare `external` anthropic-scoped subscriptions — each CLI's OWN Claude Pro/Max OAuth login (`opencode auth login`; mastracode's `/login`), backed by new `opencode`/`mastracode` provision recipes pointing at each CLI's auth store: the runtime verifies the login is present (fail-loud), injects nothing, and scrubs the api-key vars so a leftover key can't override it. Adapters/models with no matching surface fail fast at spawn with an actionable message instead of failing opaquely upstream, and the catalog stops advertising subscription profiles as runnable on them.
- Updated dependencies [64088e0]
- Updated dependencies [baf8570]
  - @agentproto/acp@0.7.2

## 2.3.0

### Minor Changes

- 27a22ca: Persistent per-session isolated adapter config directories to enable native resume after adapter respawns.

  Previously, the isolated `CLAUDE_CONFIG_DIR` was a throwaway mkdtemp recreated on every spawn. This meant the SDK's conversation store (projects/<cwd-slug>/<uuid>.jsonl) was lost on respawn, causing resumeSessionId to degrade to a digest fallback every time an adapter process was reaped and restarted.

  The fix introduces `SessionDescriptor.adapterConfigDir` to persist the config location across respawns, keyed by the first session id in a lineage (`~/.agentproto/adapter-config/<sessionId>`). The runtime threads this through all spawn paths (agent_start, session_restart, lazy resume, cron, judges, webhooks, workflow steps), and the driver preserves the SDK's own state when reusing a persistent dir while always re-asserting `mcpServers: {}` to prevent ambient leaks from mid-session `claude mcp add` commands.

  Backward compatible: legacy rows without the new field keep today's digest-fallback behavior.

- cbe11c2: Fix jcode print arm: add `--ndjson` output format and move `run` subcommand to `bin_args` so composed flags land after it (not before). Add comprehensive jcode NDJSON event mapper with full test coverage. Implement fail-fast TTY handling for interactive setup steps: refuse pre-spawn when stdin is not a TTY, return distinct `EXIT_SETUP_NEEDS_TTY (78)` to surface the condition separately from real failures. Add `needsInteractiveSetup` flag to `AdapterInstallResult` and VS Code install action to offer "Open Setup Terminal" for TTY-blocked installs.

### Patch Changes

- ce7cbb7: Append actionable PATH hint when spawn fails with ENOENT, helping users diagnose daemon environment issues.

## 2.2.2

### Patch Changes

- bf3407e: Fix unhandled ChildProcess 'error' events that crash the daemon on spawn failures (e.g., bad binary, missing PATH entry). Resolve "node" binary to process.execPath to sidestep PATH lookup issues in minimal launchd environments. Convert spawn errors to rejected promises instead of unhandled exceptions.
- 82ca9e6: Fix daemon crash from unhandled spawn errors and PATH-based node resolution issues:
  - Add error event listeners to spawn processes to prevent unhandled exceptions from crashing the daemon
  - Resolve `bin: "node"` in agent CLI definitions to `process.execPath` instead of relying on PATH lookup, preventing failures in launchd environments with minimal PATH
  - Fix auth method availability detection for models with `modelDerivedApiKey` by checking both `authSubscription` and `modelDerivedApiKey` for oauth-bearer eligibility
  - Improve test mocks to properly emit spawn events, enabling proper coverage of spawn failure scenarios

- Updated dependencies [b5ec52b]
  - @agentproto/acp@0.7.1

## 2.2.1

### Patch Changes

- 08bcd4a: Fix: Always suppress attribution (PR footer / commit trailer) in isolated agent-cli spawns, preventing settings leakage from operator's global configuration. Isolated processes now receive an explicit empty `attribution` configuration to close the ambient-leak surface.

## 2.2.0

### Minor Changes

- 3e187e5: Add Google Antigravity adapter and extend print-arm event mapper.
  - **New adapter: @agentproto/adapter-antigravity** — AIP-45 print/headless adapter for Google Antigravity's `agy` CLI (a multi-model coding agent supporting Gemini, Claude, GPT-OSS). Includes auth documentation (OS keyring + Google Sign-In), sandbox policy, and model/option configuration.
  - **Print-arm event mapper extension** — Added `antigravity-stream-json` event schema handler to support `agy`'s custom wire-event taxonomy (discriminated by `event` field, nested `conversation_id`, incremental `text_delta` fragments). The mapper handles text streaming, tool calls, tool errors, usage tracking, and session resumption via `--conversation <id>`. Supports single wire lines that fan out to multiple StreamEvents (e.g., a tool step's terminal DONE carries both call and result).
  - **Type safety** — Introduced `PrintEventSchema` type to union all supported event taxonomies; updated Zod schema validation to include `antigravity-stream-json`.
  - **Catalog entries** — Added antigravity to the CLI adapter catalog; also included two new ACP generic agents (Mistral Vibe, Kimi CLI) with their VS Code lettermark overrides.

### Patch Changes

- 492240c: Fix: unconditionally isolate CLAUDE_CONFIG_DIR for all claude-code spawns to prevent inheritance of ambient global MCP server configuration. Previously only isolated when a permission mode was explicitly requested, leading to production incidents where unscoped workers could self-spawn uncontrolled child sessions through circular MCP references. Now every claude-code spawn gets an isolated temporary config directory with explicit empty mcpServers, preventing the SDK from loading real ~/.claude.json. The permission-mode settings.json file write remains conditional on whether a mode was requested.

## 2.1.0

### Minor Changes

- c506d87: Extract OS-level process confinement (macOS Seatbelt / Linux bubblewrap) into shared `@agentproto/command-sandbox` package to resolve circular dependency, enabling both `command_execute` tool and adapter child processes to use identical backends. Add `extraWritePaths` support for write-capable directories (e.g., toolchain self-managed installs), and empirically-validated metadata-only `$HOME` allow for npm/npx compatibility. Apply confinement to agent-cli spawns in both ACP/MCP and print-protocol arms.
- 392021a: Add config-file surface and `agent_start` MCP exposure for adapter-spawn command sandboxing (PR 6b continuation):
  - **Config-file surface**: New `.agentproto/command-sandbox.json` `adapterSpawn` key (distinct from `command_execute`'s top-level `mode`) with separate env-var escape hatch (`AGENTPROTO_ADAPTER_COMMAND_SANDBOX_MODE`) to control adapter-spawn confinement persistently, justifying explicit opt-in due to larger blast radius.
  - **MCP exposure**: `commandSandbox?: "off" | "workspace" | "strict"` added to `agent_start` schema; forwarded through runtime and driver layers.
  - **Bug fix**: `serve.ts` was silently dropping `commandSandbox` from the opts destructure; fixed by including it in the spread and adding the type to `AgentAdapterResolver.startSession`.
  - **Credential access gap** (PR 6a follow-up): Added read-only paths to adapter-spawn defaults (`~/.gitconfig`, `~/.config/git`, `~/.config/gh`, `~/Library/Keychains`) fixing `git ls-remote` and `gh auth status` failures under `workspace` mode confinement.
  - **Async change**: `wrapAgentCliSpawn()` now async to support config-file loading; all callers updated.

  Backwards compatible: default behavior unchanged when no config and no explicit mode.

- 3865de6: Add file-based ("external") subscription login support for Codex and future adapters (Gemini). File-based subscriptions have the CLI read its own login file (~/.codex/auth.json), so the daemon injects NOTHING and only scrubs conflicting api-key environment variables, maintaining the money-safety invariant that no OAuth bearer is ever written to an api-key channel.

  Includes:
  - New `authSubscription: { external: true }` shape in adapter manifests for CLI-resident login files
  - `verifyLocalLoginPresent()` function to fail-loud on missing external login before spawn
  - Comprehensive test coverage for both profile-based and config-based spawn paths
  - VSCode UI integration for "Use my existing Codex login" option
  - Documentation explaining both bearer-injection (Claude Code) and file-based (Codex/Gemini) shapes

- 5643cb6: Export `createArmSessionControls` to enable hosts that build their own `AgentCliRuntimeSession` over alternative transports (e.g., e2b sandbox, remote daemon) to reuse the live-session control surface and capability read-surface members without hand-copying and drifting on future interface changes.
- 42f1217: Fix routing and credential injection for gateway-routed adapters (D1-D5)
  - D1: Base URL injection gate — skip gateway baseUrl for derived-from-model adapters (hermes); fail loud when adapter can neither accept baseUrl nor derive its route
  - D2: Wire model form — generalized stripFixedNativeVendor for fixed-provider adapters (codex/openai, codex/gpt-5 not openai/gpt-5)
  - D3: Model-derived provider precedence — adapter-declared modelProviders wins over global catalog routing (pi bills kimi via moonshot, not openrouter)
  - D4: Gateway credential injection — resolveAuthSpec honors adapter-declared gatewayAuth.setEnv instead of preset keyEnv (claude-sdk reads ANTHROPIC_AUTH_TOKEN, not OPENROUTER_API_KEY)
  - D5: LLM endpoint adoption — status report never contradicts (running:false, healthy:true); adopt external healthy endpoints as owner:external with probed model list

  New exports: LlmEndpointStatusReport, stripFixedNativeVendor, routeSelection in AgentAdapterResolver.

### Patch Changes

- c736c02: Dissociate auth profiles from routers/gateways and harness adapters. Session descriptors now carry explicit `harness`, `model`, `route`, and `accessProfile` identity. Runtime resolver derives api-key auth from the model and gateway route, injecting `base_url` + credential env without adapter hard-coding. Add native Moonshot support to `pi`, decouple `claude-sdk` from hard-coded gateway modes, and register a local `llm-endpoint` preset.
- 8367648: apply decomposed posture and context-profile axes at agent spawn
- 93e6309: Declare MastraCode's model-derived api-key auth contract and enforce it in catalog/session eligibility.
  - `@agentproto/adapter-mastracode`: adds `modelDerivedApiKey: true` so the runtime knows its direct-route API keys derive from the chosen model; the capability strategy now reports each provider's wire protocol (`apiMode`) and never claims subscription support.
  - `@agentproto/driver-agent-cli`: accepts `modelDerivedApiKey` in the AIP-45 manifest schema.
  - `@agentproto/runtime`: `buildCatalogModels` now includes api-key profiles for adapters that declare `modelDerivedApiKey`, matching `spawnEligibilityManifest`.
  - `agentproto-vscode`: Configuration Lab surfaces the corrected MastraCode eligibility (api-key profiles only; no Anthropic subscription defaults).

- 4542ca3: Curate OpenAI gpt-5.6 series (luna, sol) into claude-code and claude-sdk with `@openrouter` suffix, allowing Anthropic-native adapters to spawn these models via OpenRouter gateway. Refine auth-engagement logic to detect resolver-coupled gateway routes via `baseUrl` field in `ResolvedAuthSpec`, ensuring credentials are injected for runtime-resolved routes while protecting against native-credential leaks on manually-configured base_urls. Add comprehensive P0 test validating credential injection, base_url preservation, and scrubbing of conflicting provider vars.
- c064bc7: Migrate Codex adapter to maintained `@agentclientprotocol/codex-acp` bridge: removed fixed model defaults, switched model delivery from CLI args to ACP session config, changed model option from enum to dynamic string type. Simplified runtime to treat Codex generically (no special auth-awareness); removed `detectCodexAuthMode()` and related detection logic. Updated all test fixtures and documentation references.
- 4832ced: Terminal restart fidelity: route-aware launch config, native terminal resume capability, and resume honesty.
  - Extracts `buildRouteAwareLaunchConfig` so fresh spawn and restart inject `base_url` identically; derived-from-model adapters (e.g. hermes) no longer receive an unsupported `options.base_url`.
  - Adds `capabilities.nativeTerminalResume` to the agent-cli manifest schema and stamps it on session descriptors; `pty-native` restart is now an explicit capability, not implied by ACP resumability.
  - Preserves auth profile, route, model, posture, effort, and effective environment across restarts; wire model strips catalog `@route` suffixes and fixed-provider native vendor prefixes.
  - Resume-honesty fix: adapters declaring `resumable: false` degrade to a flagged fresh spawn instead of a phantom ACP resume.

- Updated dependencies [5ba2032]
- Updated dependencies [c506d87]
- Updated dependencies [392021a]
- Updated dependencies [b3e1648]
  - @agentproto/acp@0.7.0
  - @agentproto/command-sandbox@0.2.0

## 2.0.1

### Patch Changes

- cc00682: Skip codex -c model= override on ChatGPT-account auth
  - @agentproto/acp@0.6.0

## 2.0.0

### Major Changes

- 92c1c51: Narrow AgentCliMode.kind to "context"; drop posture/route modes from claude-code, codex, opencode

### Minor Changes

- b16bb83: Add SessionConfig axes type + decomposeMode/composeMode shim (SPEC §3.1)
- a021138: Add ACP capability read-surface (configOptions/modes) and live setSessionMode
- 48c55d5: Add live effort + live posture verbs and a model↔route switch guard

### Patch Changes

- 1411e36: Don't engage native Anthropic billing-auth when a gateway base_url is set without an auth_token
- 9fab1ad: Fix mastracode print-arm text extraction for {format,parts} content shape
- Updated dependencies [a021138]
  - @agentproto/acp@0.6.0

## 1.2.0

### Minor Changes

- 68d3093: Add models.apply:"arg" for CLI-argument model selection; fix codex-acp model spawn crash

### Patch Changes

- dd3386d: Fix session.cancel() to delegate to arm.cancel(turnId) instead of aborting the connection-level controller
- 2f8ba2d: Stop misdirecting zero-credential agent-cli users to buy a subscription

## 1.1.0

### Minor Changes

- 9cec8c5: Add structured models.allowed entries to fix gateway model mode binding in VS Code picker

### Patch Changes

- 8d73291: Fix permission-mode test env leak by isolating CLAUDE_CONFIG_DIR in beforeEach/afterEach

## 1.0.0

### Major Changes

- c036f59: Explicit credential selection + verifiable auth mode for claude-code spawns

### Minor Changes

- 049c2fe: Add generic ACP agent support: curated catalog, config-defined agents, acp verb
- 0ea6fc1: Add cross-session permission-hold inbox: permissions ls|approve|deny, MCP tools, REST routes
- 386a573: Add deterministic auth spawn mode (subscription vs api-key) for claude-code
- d425044: Add catalog-sourced billing-credential resolver for all adapters

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- 76747fc: fix(claude-code): subscription auth injects CLAUDE_CODE_OAUTH_TOKEN, not ANTHROPIC_AUTH_TOKEN
- 2d94149: Fix gateway auth collision, adapter cache invalidation, and proxy model alias override
- Updated dependencies [7b53b8c]
- Updated dependencies [0ea6fc1]
- Updated dependencies [6d4aa4b]
- Updated dependencies [60792f1]
- Updated dependencies [8a4d5d5]
- Updated dependencies [a32bb69]
- Updated dependencies [c8198c6]
  - @agentproto/acp@0.5.0
  - @agentproto/define-doctype@0.1.1

## 0.4.0

### Minor Changes

- 6b8b023: Add bin_args_prepend, plumb options map, and declare lean modes on agent-CLI adapters
- 7142f1c: Add per-mode support status (active|noop|planned) to AIP-45 agent-CLI manifest
- 3a76562: Add models.deny to agent-CLI manifest; reserve Anthropic for claude-code
- a28bebc: Add provider-presets catalog listing and AIP-45 presets manifest field

### Patch Changes

- 6f867e1: Fix print-arm ENOBUFS crash by draining stdout independently of downstream
- 6c83622: Emit usage_update transcript events for hermes and mastracode adapters
- b65ca15: Fix opencode adapter crash when mode/model set via ACP config, not CLI flags
- 7f8b45a: Export missing AgentCliPresetDeclaration type from package index
- Updated dependencies [80ca385]
- Updated dependencies [6a5c41c]
- Updated dependencies [fdb8ea1]
- Updated dependencies [b65ca15]
  - @agentproto/acp@0.4.0

## 0.3.0

### Minor Changes

- 06132bc: Implement the AIP-45 `protocol: "proprietary"` arm end to end: `createProprietaryProtocolArm` now dynamic-loads an adapter's `createAgentCliClient` factory and `createAgentCliRuntime` skips the subprocess spawn for it. Ship `@agentproto/adapter-mastracode-inprocess`, a new adapter driving Mastra Code in-process via its SDK (`createMastraCode` + `runMC`) instead of spawning the CLI, with a composite `resourceId:threadId` session id that verifiably survives a process restart. Register the new `mastracode-inprocess` slug in the CLI's adapter catalog.

  Fix `resolveAdapter` to rewrite a `protocol: "proprietary"` handle's `adapter` field to a fully-resolved absolute path before handing it off — `createProprietaryProtocolArm` re-imports that field a second time from `@agentproto/driver-agent-cli`'s own module location (which deliberately depends on no specific adapter), so a bare package-name specifier that resolved fine during discovery could fail to resolve at session-start. Applies to every proprietary adapter, not just this one.

- 2d1434a: Add mastra-jsonl print-arm schema, AgentCliPrintConfig, and adapter-mastracode
- 83aa850: Add session liveness tracking: pid, lastActivityAt, processAlive on SessionDescriptor
- 872226b: Add per-turn silence watchdog to ACP client to fix hermes hang-without-turn-end
- 06132bc: Implement AIP-45 proprietary protocol arm; ship adapter-mastracode-inprocess

### Patch Changes

- 1bf295b: Fix claude-code plan/accept-edits/bypass-permissions modes via CLAUDE_CONFIG_DIR override
- 78d09e6: Fix plan-mode sessions silently auto-approving their own exit-plan-mode escalation
- 559cff3: Fix mastracode print arm: wrong flag, fragile thread capture, mismarked resume
- c2b6779: Fix mcpServers/orchestrator mounting silently no-op'ing on mastracode and mastracode-inprocess adapters
- e27fc94: Add GET /sessions/:id/events for incremental polling; fix mastra tool_start args
- 837967a: Fix transcript-writer stripping newlines from text-delta/thought events
- Updated dependencies [83aa850]
- Updated dependencies [872226b]
- Updated dependencies [3ab696d]
- Updated dependencies [79a209a]
  - @agentproto/acp@0.3.0

## 0.2.0

### Minor Changes

- adf4583: Add print-arm protocol driver, AIP-52 harness schema, and agentproto SKILL.md
- 5c2063e: Thread mcpServers through spawn to ACP newSession/loadSession; add named Cloudflare tunnel provider
- 0022b2a: Thread mcpServers through spawn to ACP newSession/loadSession (orchestrator WP1)
- 6587000: Honor model and add effort to start_agent_session for claude-code adapter
- 04c9a5a: Add `print` protocol arm: new AgentCliProtocol member, createPrintSession export, skill/ publish

### Patch Changes

- 04c9a5a: Wire `print` protocol arm: add `"print"` to `AgentCliProtocol` + schema enum, short-circuit in `createAgentCliRuntime.start()` to call `createPrintSession` directly (the print arm spawns per-turn, not a long-lived `AgentCliClient`), export `createPrintSession`/`PrintArmOptions` from the package index, and publish the `skill/` directory from `@agentproto/cli`.
- c6a90e2: Fix effort set_config_option rejection swallowed so spawn never fails
- 7542339: Fix hermes model selection (apply:"command") + wait_for_any fast-turn race
- Updated dependencies [c6a90e2]
- Updated dependencies [4baab31]
- Updated dependencies [6587000]
  - @agentproto/acp@0.2.0
