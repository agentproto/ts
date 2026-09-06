# @agentproto/adapter-antigravity

## 0.2.6

### Patch Changes

- @agentproto/driver-agent-cli@2.4.1
- @agentproto/provider-kit@0.4.2

## 0.2.5

### Patch Changes

- Updated dependencies [dfda0b1]
- Updated dependencies [f0c51a7]
- Updated dependencies [12bb9e8]
  - @agentproto/driver-agent-cli@2.4.0
  - @agentproto/provider-kit@0.4.2

## 0.2.4

### Patch Changes

- Updated dependencies [76f2c78]
- Updated dependencies [64088e0]
- Updated dependencies [e3ad769]
  - @agentproto/driver-agent-cli@2.3.1

## 0.2.3

### Patch Changes

- a30db02: Stamp source/discoverable fields on capability strategy results
- Updated dependencies [27a22ca]
- Updated dependencies [ce7cbb7]
- Updated dependencies [cbe11c2]
  - @agentproto/driver-agent-cli@2.3.0

## 0.2.2

### Patch Changes

- Updated dependencies [bf3407e]
- Updated dependencies [82ca9e6]
  - @agentproto/driver-agent-cli@2.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [08bcd4a]
  - @agentproto/driver-agent-cli@2.2.1

## 0.2.0

### Minor Changes

- 3e187e5: Add Google Antigravity adapter and extend print-arm event mapper.
  - **New adapter: @agentproto/adapter-antigravity** — AIP-45 print/headless adapter for Google Antigravity's `agy` CLI (a multi-model coding agent supporting Gemini, Claude, GPT-OSS). Includes auth documentation (OS keyring + Google Sign-In), sandbox policy, and model/option configuration.
  - **Print-arm event mapper extension** — Added `antigravity-stream-json` event schema handler to support `agy`'s custom wire-event taxonomy (discriminated by `event` field, nested `conversation_id`, incremental `text_delta` fragments). The mapper handles text streaming, tool calls, tool errors, usage tracking, and session resumption via `--conversation <id>`. Supports single wire lines that fan out to multiple StreamEvents (e.g., a tool step's terminal DONE carries both call and result).
  - **Type safety** — Introduced `PrintEventSchema` type to union all supported event taxonomies; updated Zod schema validation to include `antigravity-stream-json`.
  - **Catalog entries** — Added antigravity to the CLI adapter catalog; also included two new ACP generic agents (Mistral Vibe, Kimi CLI) with their VS Code lettermark overrides.

### Patch Changes

- Updated dependencies [3e187e5]
- Updated dependencies [492240c]
  - @agentproto/driver-agent-cli@2.2.0
