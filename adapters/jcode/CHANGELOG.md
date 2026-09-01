# @agentproto/adapter-jcode

## 0.2.4

### Patch Changes

- Updated dependencies [4b924c9]
- Updated dependencies [008a483]
- Updated dependencies [3496977]
- Updated dependencies [008a483]
- Updated dependencies [dfda0b1]
- Updated dependencies [f0c51a7]
- Updated dependencies [12bb9e8]
- Updated dependencies [001a2a0]
- Updated dependencies [5dcc733]
  - @agentproto/model-catalog@0.9.0
  - @agentproto/driver-agent-cli@2.4.0
  - @agentproto/provider-kit@0.4.2

## 0.2.3

### Patch Changes

- 64088e0: Refuse to run a derived-from-model adapter on its default model when the requested model was not applied. Launching opencode with an id its server can't resolve (e.g. a claude-code-style `…@openrouter` suffix) used to warn on the daemon's stderr and silently run — and bill — the server's default `anthropic/claude-sonnet-4-5` instead; hermes had the same hole one strategy over (its spawn-time `/model <id>` control turn's result was ignored), and jcode a protocol over (its CLI silently falls back to its own default on an unknown `--model` id — observed live: `--model totally-bogus-xyz` → started on `gpt-5.6-sol`/OpenAI). Three guards now share one contract for `routeSelection:"derived-from-model"` adapters: the ACP client records a connect-time model rejection structurally (`AcpClientSession.modelApplyRejection`) and the driver refuses the spawn on a rejected `set_config_option` (opencode-style `apply:"config"`) or an unacknowledged/failed `/model` control turn (hermes-style `apply:"command"`); the print arm aborts a turn whose jcode-ndjson `start` line reports a model contradicting the requested one (basename compare, `@route`-suffix/`provider/`-prefix tolerant). Every refusal names the requested id and the concrete reason. Free/fixed-routing adapters keep the agentproto#186 warn-and-continue behavior unchanged; pi errors properly on its own (`Model not found`) and needs no guard.
- Updated dependencies [95f7b5e]
- Updated dependencies [e826a4a]
- Updated dependencies [76f2c78]
- Updated dependencies [64088e0]
- Updated dependencies [e3ad769]
- Updated dependencies [1fd4a15]
  - @agentproto/model-catalog@0.8.5
  - @agentproto/driver-agent-cli@2.3.1

## 0.2.2

### Patch Changes

- 132ffe5: Documentation updates for CLI enhancements, adapter protocol changes, and provider preset expansion.
  - **@agentproto/adapter-jcode**: Updated protocol documentation to reflect NDJSON streaming support and added exit code semantics for setup requiring TTY (code 78).
  - **@agentproto/cli**: Documented new session commands (`prompt`, `pin`, `unpin`), daemon capabilities (PATH self-healing, version reporting in `/health`), file upload endpoint for `app serve`, and added grok-cli adapter reference.
  - **@agentproto/provider-presets**: Added documentation for new provider presets: OpenAI, Mistral, Groq, Nebius, Hugging Face, and DeepInfra.

- Updated dependencies [7b28edf]
- Updated dependencies [e8d39e8]
  - @agentproto/model-catalog@0.8.4

## 0.2.1

### Patch Changes

- a30db02: Stamp source/discoverable fields on capability strategy results
- cbe11c2: Fix jcode print arm: add `--ndjson` output format and move `run` subcommand to `bin_args` so composed flags land after it (not before). Add comprehensive jcode NDJSON event mapper with full test coverage. Implement fail-fast TTY handling for interactive setup steps: refuse pre-spawn when stdin is not a TTY, return distinct `EXIT_SETUP_NEEDS_TTY (78)` to surface the condition separately from real failures. Add `needsInteractiveSetup` flag to `AdapterInstallResult` and VS Code install action to offer "Open Setup Terminal" for TTY-blocked installs.
- Updated dependencies [27a22ca]
- Updated dependencies [ce7cbb7]
- Updated dependencies [cbe11c2]
  - @agentproto/driver-agent-cli@2.3.0

## 0.2.0

### Minor Changes

- 5798b49: Add AIP-45 adapter for 1jehuang/jcode — a RAM-efficient Rust coding agent with semantic memory, multi-agent swarm coordination, and multi-provider support (Claude, OpenAI, Gemini, OpenRouter, DeepSeek, Groq, Mistral, Ollama).

  Adapter uses `print` protocol (headless mode): spawns `jcode run "<prompt>"` per turn and captures stdout. No ACP mode is currently documented; swarm coordination not yet wired.

### Patch Changes

- Updated dependencies [415044d]
- Updated dependencies [bf3407e]
- Updated dependencies [82ca9e6]
  - @agentproto/model-catalog@0.8.3
  - @agentproto/driver-agent-cli@2.2.2
