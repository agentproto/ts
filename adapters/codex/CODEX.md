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
  default: gpt-5-codex
  allowed:
    - gpt-5-codex
    - gpt-5
    - gpt-5-mini
    - gpt-5-pro
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
