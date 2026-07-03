# @agentproto/cli

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
