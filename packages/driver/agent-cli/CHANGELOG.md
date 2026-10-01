# @agentproto/driver-agent-cli

## 2.7.0

### Minor Changes

- a878968: Slash-command dispatch decision util (AIP-44 available_commands groundwork):
  pure `slash-dispatch` module — `parseSlashInvocation`, `matchSlashCommand`,
  `classifySlashPrompt`, `asSlashPromptBlocks` — that classifies a leading
  `/name` prompt against the adapter's own `available_commands_update` list
  (hermes `SlashCommandsMixin`, claude-agent-acp `sendAvailableCommandsUpdate`,
  opencode ACP directory snapshot) and pins the transport contract: dispatch is
  adapter-side on the verbatim first text block, so host-side prepends
  (reasoning digests, fyi inbox digests, resume-context digests) keep slash
  commands from ever reaching the adapter's dispatcher.

## 2.6.4

### Patch Changes

- 85051ab: Windows fixes for the pi stack from the WIN11 #1637 field test (agentproto 1.7.1):

  - driver-agent-cli proprietary arm: a dynamic `import()` of an ABSOLUTE filesystem path
    (the fully-resolved adapter produced by `withResolvedProprietaryAdapter`) failed on
    win32 with `ERR_UNSUPPORTED_ESM_URL_SCHEME` / `Received protocol 'c:'`. Absolute paths
    are now rewritten via `pathToFileURL()` before `import()`; bare npm specifiers import
    as before. POSIX behavior is unchanged.
  - adapter-pi: `spawn pi ENOENT` on win32 — the installed binary is a `.cmd` shim
    (`pi.cmd` on PATH, wrapper reapps of `%USERPROFILE%\.pi\agent\bin` or the npm global
    prefix) and Node's spawn without `shell` does no PATHEXT resolution. pi session spawns
    now resolve the binary through PATH; a `.cmd`/`.bat` shim is rewritten to its package
    entry JS (`node <…>/pi-coding-agent/dist/bundle/cli.js`) when a sibling exists, else
    spawned with `shell: true` (args are internal constants only).

## 2.6.3

### Patch Changes

- Updated dependencies [11c1e09]
  - @agentproto/acp@0.9.2

## 2.6.2

### Patch Changes

- 6bace2a: win32 field fixes (BOOTSTRAP P3, reproduced 2026-09-30 on Windows 11 / Node 26.10.0)

  - `driver-agent-cli`: `resolveWindowsBatchSpawn` now probes for the npm shim's real
    node entry with the actual filesystem when called without injected deps. The
    shipped dist evaluated a placeholder `() => false`, so the stage-1 rewrite never
    returned and every `bin: "npx"` spawn fell to `shell: true` — where cmd.exe
    mangled the quoted `C:\Program Files\nodejs\...` path, every `agent_start`
    failed with "ACP connection closed", the VS Code terminal with "pty failed to
    spawn", and chat with HTTP 500. Regression-tested against a real fs fixture
    under a path containing a space.
  - `cli`: the scheduled-task launcher `~/.agentproto/agentproto-daemon.cmd` now
    starts with `cd /d` to the configured `daemon.workspace` (otherwise
    `%USERPROFILE%`). The task used to run from `C:\Windows\System32`, where the
    daemon died EPERM creating `.agentproto/runtime.json`. `agentproto daemon stop`
    no longer trusts `schtasks /End` alone: it probes `/health`, and when the port
    still answers kills the recorded PID tree (`taskkill /PID <pid> /T /F`) and
    re-probes — the node child used to keep listening, so a later `start` reused a
    zombie daemon and new code never loaded.
  - `runtime`: after 5 consecutive failed host dials the controller logs the
    one-line remediation "host handshake failing — the controller should re-run
    `agentproto devices add` with a fresh `pair offer --host`" (classically: a
    Windows reboot invalidated the old host registration and nothing in the log
    pointed at the fix). `agentproto doctor`'s devices check flags a host whose
    channel is failing its handshake recently and prints the same hint. No
    pairing-protocol change.

## 2.6.1

### Patch Changes

- 3d9626a: Windows P0 fixes from the WIN11 onboarding test.

  - `agentproto setup <slug>` now auto-installs the adapter package (`npm i -g`, the package manager that owns the CLI) before failing on a missing `@agentproto/adapter-<slug>`, shared with `agentproto install`'s existing bootstrap; dry-run prints what would run and npm failures keep the original clear error.
  - Adapter launches (ACP + print arms) are win32-aware: npm `.cmd` shims are rewritten to their real `node …-cli.js` entry (staying `shell:false`), and any remaining `.cmd`/`.bat` bin spawns with `shell: true` — Node ≥ 18.20.2 refuses direct batch-file spawning with `spawn EINVAL` (CVE-2024-27980), which is what killed device-sandbox spawns onto joined Windows hosts.
  - `npm` invocations in the install verb go through cmd.exe on Windows (a shell-less npm spawn is ENOENT there — libuv resolves only `.exe` and npm global bins are `.cmd` shims).
  - `scripts/bootstrap/install.ps1` sets ExecutionPolicy (CurrentUser only) from Restricted to RemoteSigned, prints the exact command and its undo, and always invokes npm via `npm.cmd` so the script works even when group policy refuses the change.
  - @agentproto/acp@0.9.1

## 2.6.0

### Minor Changes

- 6a1bedc: App-spawned sessions (`app_run`, and workflow agent steps whose workflow carries an `appId`) now get filesystem zones: the installed app source is read-only, the run workspace and app `data/` dir are writable, everything else is denied. Enforced on the daemon's own file/command tools always; on the harness's native tools (claude-code) via `@agentproto/command-sandbox` zoned mode plus host `CLAUDE.md`/`AGENTS.md` exclusion when the adapter and OS sandbox support it. Apps opt into `boundaries: { enforce: "required" }` in `defineApp`/`APP.md` to refuse a spawn instead of silently downgrading when native enforcement isn't available.

### Patch Changes

- Updated dependencies [461df5e]
- Updated dependencies [6a1bedc]
  - @agentproto/define-doctype@0.1.3
  - @agentproto/command-sandbox@0.3.0
  - @agentproto/acp@0.9.1

## 2.5.1

### Patch Changes

- 9a5730d: `agent_prompt`/`agent_start` (MCP) now accept the same content-block prompt shape the HTTP `POST /sessions/:id/prompt` route already did (new shared `promptInputSchema`). Print-arm adapters (`@agentproto/driver-agent-cli`) fail loudly with a turn error on non-text blocks instead of silently dropping them. `transcript-writer` materializes inline-bytes blocks (pasted images) into a content-addressed attachment store, and a new `GET /sessions/:id/attachments/:filename` route reads one back (new `AttachmentEntry`/`mimeTypeForExtension`/`sessionAttachmentsDir` exports).
  - @agentproto/acp@0.9.0

## 2.5.0

### Minor Changes

- dc87d79: Track claude-code's background-task wake instead of dropping it
- 583ee19: Live-session teardown fixes: `DELETE /sessions/:id` (and `registry.forget`) now tears a still-running session down through the full kill teardown (adapter close, PTY/child SIGTERM, `session:exited` emit) before dropping the row, returning an additive `killed` field; adapter closes in the agent CLI now terminate the whole child process tree (SIGTERM → grace period → SIGKILL) so `npx` wrappers, MCP servers, and headless Chrome can no longer outlive the session.

### Patch Changes

- 8c74864: stdio MCP-server entries now carry `args` and `env` end to end: the ACP schema, runtime tool/HTTP parsing, spawn and restart mount builders, the file-based config converter, and the VS Code client type all forward them instead of silently dropping them. The local-browser plugin additionally exports headless per-session browser helpers (`ensureChromeDevtoolsMcp`, `resolveChrome`, `buildHeadlessBrowserMcpEntry`, …) and `installChromeMcp` gains generic `pkg`/`binName` options.
- c9e8318: F34b: exec a pinned `npx -y pkg@x.y.z` adapter's cached bin directly instead of paying `npm exec`'s tree scans and locks (fail-closed to a plain npx spawn otherwise), and mark a running workflow agent step whose session is still booting as `phase: "spawning"` in `workflow_status` until its session id attaches.
- Updated dependencies [65777ee]
- Updated dependencies [8c74864]
- Updated dependencies [dc87d79]
- Updated dependencies [7d825ff]
- Updated dependencies [535779b]
- Updated dependencies [476b1ca]
- Updated dependencies [5f0f9d1]
  - @agentproto/acp@0.9.0

## 2.4.4

### Patch Changes

- c27f0b8: Weekly minor/patch dependency bumps across workspaces (zod, @mastra/*, react, yaml, claude-agent-sdk, etc.).
- Updated dependencies [c27f0b8]
  - @agentproto/acp@0.8.2

## 2.4.3

### Patch Changes

- Updated dependencies [fee0522]
  - @agentproto/command-sandbox@0.2.2

## 2.4.2

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [2f37e7b]
  - @agentproto/acp@0.8.1
  - @agentproto/command-sandbox@0.2.1
  - @agentproto/define-doctype@0.1.2

## 2.4.1

### Patch Changes

- Updated dependencies [0012980]
  - @agentproto/acp@0.8.0
  - @agentproto/command-sandbox@0.2.0
  - @agentproto/define-doctype@0.1.1

## 2.4.0

### Minor Changes

- dfda0b1: Fix spawn ENOENT on launchd daemons: resolve npx/npm to sibling binaries, ensure exec dir on child PATH, and disambiguate missing cwd from missing binary in error messages.
- 12bb9e8: Add support for tracking model switches sent as ordinary prompts. Introduces an optional `activeModel` field to `SessionDescriptor` that captures the model believed to be running after a live switch, distinct from `model` (the requested/spawn-time value). The daemon learns switches from two paths: (1) a successful `setModel` call (verified, mirrors `model`), or (2) a `/model <id>` command sent as a plain conversational prompt followed by an adapter acknowledgement (unverified, advisory only — for UI display, never billing). Exports `isModelSwitchAcknowledgement()` and `parseModelSwitchCommand()` from agent-cli for reuse across both paths. VS Code's composer chip now renders "requested → active" when they diverge.

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
  - @agentproto/acp@0.7.3

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
