# @agentproto/adapter-jcode

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
