---
name: opencode
id: opencode
description: sst/opencode — open-source coding agent with first-party ACP mode. Spawned as `npx -y opencode-ai acp`, drives the agent over stdio JSON-RPC. Multi-provider (Anthropic, OpenAI, Groq, OpenRouter, OpenCode-hosted, …) — operator picks the underlying model via env-keyed provider auth.
version: 0.1.0
bin: npx
bin_args: ["-y", "opencode-ai", "acp"]
install:
  - method: npm
    package: opencode-ai
    global: true
  - method: curl
    url: https://opencode.ai/install
version_check:
  cmd: npm view opencode-ai version
  parse: "(\\d+\\.\\d+\\.\\d+)"
  range: ">=1.0.0"
  timeout_ms: 15000
auth:
  ref: ./SECRETS.md
  state:
    env: [OPENCODE_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY]
sandbox: ./SANDBOX.md
protocol: acp
acp: ./opencode-acp.ACP.md
session:
  mode: persistent
  idle_timeout_ms: 1800000
  context_carryover: true
models:
  default: anthropic/claude-sonnet-4-6
  allowed:
    - anthropic/claude-sonnet-4-6
    - anthropic/claude-opus-4-7
    - anthropic/claude-haiku-4-5
    - openai/gpt-5
    - openai/gpt-5-mini
    - openrouter/anthropic/claude-sonnet-4-6
  env:
    anthropic: ANTHROPIC_API_KEY
    openai: OPENAI_API_KEY
    openrouter: OPENROUTER_API_KEY
    opencode: OPENCODE_API_KEY
    groq: GROQ_API_KEY
capabilities:
  streaming: true
  tool_calls: true
  sub_agents: false
  file_io: true
  multimodal: true
  resumable: true
  bidirectional: true
tags: ["opencode", "sst", "acp", "agent-runtime", "coding"]
---

# OpenCode adapter

`@agentproto/adapter-opencode` wraps **sst/opencode** as an AIP-45 agent
CLI. OpenCode ships its own ACP server — no third-party wrapper is
needed; the adapter spawns `npx -y opencode-ai acp` and drives the
agent over stdio JSON-RPC.

## Why OpenCode

- Multi-provider (Anthropic, OpenAI, OpenRouter, Groq, OpenCode hosted)
- First-party ACP mode (vs claude-code which needs a wrapper)
- MIT-licensed, broad community plugin surface

## Install

```bash
# npm (global)
npm install -g opencode-ai

# or curl bootstrap
curl -fsSL https://opencode.ai/install | bash
```

The npx form `npx -y opencode-ai acp` works without a global install
— the adapter prefers this for ephemeral / sandboxed spawns.

## Auth

OpenCode reads provider keys from the environment. Set whichever
provider the operator's `models.default` is pinned to:

| Provider     | Env var               |
|--------------|-----------------------|
| Anthropic    | `ANTHROPIC_API_KEY`   |
| OpenAI       | `OPENAI_API_KEY`      |
| OpenRouter   | `OPENROUTER_API_KEY`  |
| Groq         | `GROQ_API_KEY`        |
| OpenCode SaaS| `OPENCODE_API_KEY`    |
