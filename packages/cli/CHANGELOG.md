# @agentproto/cli

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
