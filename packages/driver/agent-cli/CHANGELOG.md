# @agentproto/driver-agent-cli

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
