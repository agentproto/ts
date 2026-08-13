---
name: grok-cli
id: grok-cli
description: xAI's official Grok Build CLI (`grok agent stdio`) — a Rust terminal coding agent driving Grok models over the Agent Client Protocol via stdio JSON-RPC. Installed via the official x.ai installer script (no npm package).
version: 0.1.0
bin: grok
bin_args: ["agent", "stdio"]
install:
  - method: curl
    url: "https://x.ai/cli/install.sh"
version_check:
  cmd: grok --version
  parse: "(\\d+\\.\\d+\\.\\d+)"
  range: ">=1.0.0"
  timeout_ms: 15000
auth:
  state:
    env: [XAI_API_KEY]
sandbox: ./SANDBOX.md
protocol: acp
acp: ./grok-acp.ACP.md
session:
  mode: persistent
  idle_timeout_ms: 1800000
  context_carryover: true
models:
  default: grok-4.20-0309-non-reasoning
  allowed:
    - grok-4.20-0309-non-reasoning
    - grok-4.20-0309-reasoning
    - grok-4.20-multi-agent-0309
    - grok-4.3
    - grok-4.5
    - grok-4.6
    - grok-build-0.1
  env:
    xai: XAI_API_KEY
capabilities:
  streaming: true
  tool_calls: true
  sub_agents: false
  file_io: true
  multimodal: false
  resumable: true
  bidirectional: true
tags: ["grok", "xai", "acp", "agent-runtime", "coding"]
---

# Grok CLI adapter

`@agentproto/adapter-grok-cli` wraps xAI's official **Grok Build** CLI
(binary name `grok`, GitHub: `xai-org/grok-build`, docs:
<https://docs.x.ai/build/overview>) as an AIP-45 agent CLI by spawning
`grok agent stdio` — the CLI's own ACP-over-stdio subcommand.

## Why this is native ACP, not a bridge

Unlike Codex (no ACP mode of its own; wrapped by a third-party
`@agentclientprotocol/codex-acp` bridge), the Grok CLI speaks Agent
Client Protocol directly. Verified with a live handshake against grok
1.0.3: `initialize` returns `agentCapabilities`, `authMethods`
(`xai.api_key`, `grok.com`), and a live `modelState`; `session/new`
returns a real session id; `session/prompt` streams a reply and
`session/update` notifications.

## Install

xAI does not publish an npm package for this CLI. The only official
distribution channel is the installer script referenced from
<https://docs.x.ai/build/overview>:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

This downloads a platform-specific binary from `x.ai/cli` (falling back
to a Google Cloud Storage mirror) to `~/.grok/bin/grok` and adds it to
`PATH`.

**Do not confuse this with `@xai-official/grok` on npm.** That package
has no linked GitHub repository, no homepage, an `-official` scope name
legitimate vendors don't apply to themselves, and 189 published versions
with a bot-like same-day publish cadence going back to October 2025 —
signatures consistent with a typosquat, not xAI's real release process.
It is not used anywhere in this adapter.

## Auth

Grok authenticates one of two ways:

| Mechanism  | How                                                        |
|------------|-------------------------------------------------------------|
| Grok login | `grok login --oauth` / `--device-auth` (writes `~/.grok/auth.json`, read directly by the CLI — "grok.com" in ACP `authMethods`) |
| API key    | `XAI_API_KEY=xai-…`                                          |

For headless / sandboxed spawns, prefer `XAI_API_KEY`.

## What's verified vs. assumed

Verified live against grok 1.0.3 on macOS (`grok --help`, `grok agent
--help`, `grok models`, a live ACP `initialize`/`session/new`/
`session/prompt` handshake, and one live single-turn `-p` call in
`plain`/`json`/`streaming-json` output formats): the `grok` binary name,
`agent stdio` ACP subcommand, `-m/--model` flag, `XAI_API_KEY` env var,
the model id list, `install.sh` installer contents, and the ACP
capability/authMethods/model-state shape reflected in `capabilities`
above.

Not independently verified in this pass: behavior of `--sandbox
<PROFILE>` / `GROK_SANDBOX` (flag exists per `--help`, semantics
untested), MCP server wiring beyond `grok mcp --help`'s command list,
and long-running session resume across a real daemon restart.
