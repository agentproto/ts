---
name: codex
id: codex
description: OpenAI's Codex coding agent wrapped as an ACP server by @agentclientprotocol/codex-acp. Spawned via a version-pinned npx package and driven over stdio JSON-RPC. The wrapper bundles a compatible Codex runtime — no separate @openai/codex install required.
version: 0.1.0
bin: npx
bin_args: ["-y", "@agentclientprotocol/codex-acp@1.1.14"]
install:
  - method: npm
    package: "@agentclientprotocol/codex-acp@1.1.14"
    global: true
version_check:
  cmd: npm view @agentclientprotocol/codex-acp@1.1.14 version
  parse: "(\\d+\\.\\d+\\.\\d+)"
  range: "=1.1.14"
  timeout_ms: 15000
auth:
  ref: ./SECRETS.md
  state:
    env: [OPENAI_API_KEY, CODEX_API_KEY]
sandbox: ./SANDBOX.md
protocol: acp
acp: ./codex-acp.ACP.md
session:
  mode: persistent
  idle_timeout_ms: 1800000
  context_carryover: true
models:
  # Mirrors `models.allowed` in src/index.ts. Not a gate: Codex validates
  # explicit ids dynamically against the signed-in account, so this is a
  # discovery menu for catalog consumers.
  default: gpt-5-codex
  allowed:
    # Codex-specialized (coding) models.
    - gpt-5-codex
    - gpt-5.1-codex
    - gpt-5.1-codex-mini
    - gpt-5.1-codex-max
    - gpt-5.2-codex
    # GPT-5 generalist family.
    - gpt-5
    - gpt-5-mini
    - gpt-5-nano
    - gpt-5-pro
    - gpt-5.1
    - gpt-5.2
    - gpt-5.4
    - gpt-5.4-mini
    - gpt-5.4-nano
    - gpt-5.4-pro
    - gpt-5.5
    - gpt-5.5-pro
    # GPT-5.6 family.
    - gpt-5.6-luna
    - gpt-5.6-luna-pro
    - gpt-5.6-sol
    - gpt-5.6-sol-pro
    - gpt-5.6-terra
    - gpt-5.6-terra-pro
    # GPT-6 family (no gpt-6-terra and no gpt-6-codex exist upstream).
    - gpt-6-luna
    - gpt-6-luna-pro
    - gpt-6-sol
    - gpt-6-sol-pro
    - gpt-6-astra
    - gpt-6-astra-pro
    # GPT-4.1 / 4o generation.
    - gpt-4.1
    - gpt-4.1-mini
    - gpt-4.1-nano
    - gpt-4o
    - gpt-4o-mini
    # o-series reasoning models.
    - o3
    - o3-pro
    - o3-mini
    - o3-deep-research
    - o4-mini
    - o4-mini-high
    - o4-mini-deep-research
    - o1
    - o1-mini
    - o1-pro
  env:
    openai: OPENAI_API_KEY
    codex: CODEX_API_KEY
capabilities:
  streaming: true
  tool_calls: true
  sub_agents: false
  file_io: true
  multimodal: true
  resumable: true
  bidirectional: true
tags: ["codex", "openai", "acp", "agent-runtime", "coding"]
---

# Codex adapter

`@agentproto/adapter-codex` wraps OpenAI's Codex coding agent as an
AIP-45 agent CLI by spawning **`@agentclientprotocol/codex-acp`** — the
maintained ACP bridge, which bundles a compatible Codex runtime.

## Why this wrapper

OpenAI's `@openai/codex` CLI does not expose an ACP mode. The Zed
wrapper provides a stable stdio JSON-RPC bridge with full ACP session
lifecycle support (newSession / loadSession / resumeSession), slash
commands, ACP `AvailableCommands` updates, and read-only / auto /
full-access session modes.

## Install

```bash
# npm (global) — recommended for fast spawn
npm install -g @agentclientprotocol/codex-acp@1.1.14

# or rely on the npx form (no manual install)
npx -y @agentclientprotocol/codex-acp@1.1.14
```

The wrapper ships platform-specific native binaries via npm optional
dependencies — no separate `@openai/codex` install is required.

## Auth

Codex authenticates one of three ways:

| Mechanism      | How                                                       |
|----------------|-----------------------------------------------------------|
| ChatGPT login  | Use the existing paid ChatGPT subscription via OAuth      |
| API key        | `CODEX_API_KEY=sk-…`                                      |
| Fallback       | `OPENAI_API_KEY=sk-…`                                     |

For headless / sandboxed spawns, prefer `OPENAI_API_KEY`.
