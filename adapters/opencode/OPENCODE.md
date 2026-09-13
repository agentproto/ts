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
    - opencode-go/glm-5.3
    - opencode/claude-sonnet-4-6
  env:
    anthropic: ANTHROPIC_API_KEY
    openai: OPENAI_API_KEY
    openrouter: OPENROUTER_API_KEY
    opencode: OPENCODE_API_KEY
    opencode-go: OPENCODE_API_KEY
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
| OpenCode Zen | `OPENCODE_API_KEY`    |
| OpenCode Go  | `OPENCODE_API_KEY`    |

## OpenCode Go / OpenCode Zen

OpenCode's own two hosted endpoints are first-class billing routes in the
catalog, so the generated model menu offers them directly:

| Route | Endpoint | Models | Billing |
|-------|----------|--------|---------|
| `opencode-go` | `https://opencode.ai/zen/go/v1` | 36 | Flat **OpenCode Go** subscription ($10/mo), metered against dollar caps at each model's own per-token price |
| `opencode` | `https://opencode.ai/zen/v1` | 102 | **OpenCode Zen**, pay-as-you-go (includes the whole Claude family, the gpt-5.x/codex family, Gemini, and many `-free` variants at a real $0) |

Model ids are `opencode-go/<id>` / `opencode/<id>` — opencode's own config
spelling, and exactly what goes on the wire. For these two the route IS the
id's leading segment, so there is no `@route` suffix; the runtime derives the
billing endpoint from that prefix and injects `OPENCODE_API_KEY`, the same
`modelDerivedApiKey` path the other providers use.

```bash
agentproto auth provider set opencode-go <key>    # or: opencode, for Zen
agentproto sessions start --adapter opencode --model opencode-go/glm-5.3
```

Both routes read the **same** env var (`OPENCODE_API_KEY`) — opencode's own
convention. A Zen key and a Go key are different secrets sharing one name, so a
host that stores both can only inject one; pin the rail you mean with an auth
profile whose `endpoint` is `opencode` or `opencode-go` (`--access-profile`),
which is what the spawn-time eligibility check joins on.

Neither endpoint is a login: **Go and Zen are API keys, not OAuth**. The
adapter's two `authSubscription` surfaces remain opencode's own
`opencode auth login` flows for Claude Pro/Max and ChatGPT, untouched by these
routes.
