# @agentproto/adapter-jcode

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
