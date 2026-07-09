---
name: pi
id: pi
description: earendil-works/pi — MIT headless TypeScript coding agent. Driven over pi's persistent JSON-over-stdio RPC mode (`pi --mode rpc`) as a spawned child. Multi-provider (Anthropic/OpenAI/Google), streaming, live-duplex (steer/follow-up/abort mid-turn). No ACP, NO MCP — pi runs only its own built-in file/shell tools; injected MCP servers are ignored.
version: 0.1.0
bin: pi
install:
  - method: npm
    package: "@earendil-works/pi-coding-agent"
    global: true
  - method: curl
    url: https://pi.dev/install.sh
version_check:
  cmd: npm view @earendil-works/pi-coding-agent version
  parse: "(\\d+\\.\\d+\\.\\d+)"
  range: ">=0.80.0"
  timeout_ms: 15000
auth:
  ref: ./SECRETS.md
  state:
    env: [ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY]
sandbox: ./SANDBOX.md
protocol: proprietary
adapter: "@agentproto/adapter-pi"
session:
  mode: persistent
  idle_timeout_ms: 1800000
  turn_idle_timeout_ms: 300000
  context_carryover: true
capabilities:
  streaming: true
  tool_calls: true
  sub_agents: false
  file_io: true
  multimodal: true
  resumable: true
  bidirectional: true
continuation:
  default: native-resume
  supported: [native-resume, pinned-session, transcript, none]
tags: [pi, earendil, proprietary, rpc, agent-runtime, coding, no-mcp]
---

# Pi — AIP-45 manifest overview

`@agentproto/adapter-pi` drives **earendil-works/pi**
(`@earendil-works/pi-coding-agent`) as a `protocol: "proprietary"` AGENT-CLI
operator. The canonical, executable manifest lives in `src/index.ts`
(`defineAgentCli({...})`); this file is the human-readable overview.

## Why `protocol: "proprietary"`

Pi ships neither ACP nor MCP, so neither the `acp` nor the `print` arm applies.
Pi *does* ship a persistent JSON-over-stdio RPC mode (`pi --mode rpc`), so the
adapter implements the proprietary-arm `AgentCliClient` contract directly:
`createAgentCliRuntime` skips its own subprocess plumbing and dynamic-imports
this package's `createAgentCliClient` factory, which spawns `pi --mode rpc`
and translates the stream. See [`PI-RPC.md`](./PI-RPC.md) for the wire profile.

## Protocol arm

- **`bin`**: `pi` — a real binary. The proprietary arm never spawns it for you;
  `client.ts` does, invoking `pi --mode rpc`. `AGENTPROTO_PI_BIN` overrides the
  path.
- **`adapter`**: `@agentproto/adapter-pi` (self-reference the proprietary arm
  dynamic-imports at session start).

## Models

Default `anthropic/claude-sonnet-4-5`. `allowed` is a curated cross-provider
menu (`anthropic/claude-sonnet-4-5`, `openai/gpt-5.1`,
`google/gemini-2.5-flash`); the free-form `model` option accepts any pattern
pi's `--model` understands (`provider/id`, verified against pi's
`core/model-resolver.ts`). `env` maps provider → key env var.

## Options

| id       | type   | values | maps to |
| -------- | ------ | ------ | ------- |
| `model`  | string | free-form `provider/id` | pi `--model <pattern>` spawn flag |
| `effort` | enum   | `off, minimal, low, medium, high, xhigh` | pi `set_thinking_level` RPC command |

## Modes

A single `default` mode. Pi's RPC surface exposes no plan/build/read-only mode
switch, so none is invented — the manifest stays honest.

## Continuation

`native-resume` by default. `client.ts` captures pi's session id from the
`get_state` response after connect; the host persists it and, on a cold start,
`connect({ resumeSessionId })` re-spawns pi with `--session <id>`.

## Capabilities & the no-MCP caveat

`sub_agents: false` because pi cannot mount the orchestration gateway (no MCP).
`connect({ mcpServers })` is accepted but **ignored**, with a one-time warning
— see [`README.md`](./README.md) and [`SANDBOX.md`](./SANDBOX.md).
