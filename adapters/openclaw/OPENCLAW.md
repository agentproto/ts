---
name: openclaw
id: openclaw
description: OpenClaw — coding-agent platform with a native plugin surface and built-in ACP bridge. `openclaw acp` exposes a Gateway session as an ACP server over stdio JSON-RPC; an external host (Zed, agentproto driver) drives prompts and the bridge forwards them to the Gateway over WebSocket. Requires an onboarded local Gateway service, or explicit remote Gateway URL/token injection.
version: 0.1.0
bin: openclaw
bin_args: [acp]
install:
  - method: curl
    url: https://openclaw.ai/install.sh
  - method: npm
    package: openclaw
    global: true
    experimental: true
version_check:
  cmd: openclaw --version
  parse: "(\\d+\\.\\d+\\.\\d+)"
  range: ">=0.1.0"
  timeout_ms: 5000
setup:
  - id: install-daemon
    kind: cmd
    cmd: "openclaw onboard --install-daemon"
    skip_if:
      cmd: "openclaw gateway probe"
      exit_code: 0
    description: "Installs and starts the OpenClaw background daemon (one-time per host)."
    interactive: true
    timeout_ms: 300000
  - id: ready-check
    kind: cmd
    cmd: "openclaw gateway probe"
    description: "Confirms the OpenClaw Gateway is reachable and write-capable."
    timeout_ms: 30000
auth:
  ref: ./SECRETS.md
  state:
    env: [OPENCLAW_GATEWAY_URL, OPENCLAW_GATEWAY_TOKEN, OPENCLAW_GATEWAY_PASSWORD]
sandbox: ./SANDBOX.md
protocol: acp
acp: ./openclaw-acp.ACP.md
session:
  mode: persistent
  idle_timeout_ms: 1800000
  context_carryover: true
capabilities:
  streaming: true
  tool_calls: true
  sub_agents: true
  file_io: true
  multimodal: true
  resumable: true
  bidirectional: true
tags: ["openclaw", "acp", "agent-runtime", "coding"]
---

# OpenClaw adapter

`@agentproto/adapter-openclaw` drives **OpenClaw** as an AIP-45 agent
CLI. OpenClaw ships a native ACP bridge (`openclaw acp`) that talks
ACP over stdio JSON-RPC and forwards prompts to the OpenClaw Gateway
over WebSocket — so a host like Zed, an editor, or the agentproto
driver-agent-cli can drive OpenClaw the same way it drives Claude
Code or Hermes.

Unlike pure npx adapters (claude-code, opencode, codex), OpenClaw
needs a one-time onboarding step on the host machine: the local
Gateway service has to be installed, started, and authenticated. Remote
Gateway URL/token injection is still supported through env vars or
spawn options, but the default local flow relies on OpenClaw's own
persisted config.

## Install

The agentproto installer drives both the binary install and the
post-install onboarding via the manifest's `install[]` and `setup[]`
blocks:

```bash
agentproto install openclaw
# ↓ install[]: curl https://openclaw.ai/install.sh | bash (or npm)
# ↓ setup[]:
#   • install-daemon   — `openclaw onboard --install-daemon`
#                        (skipped when `openclaw gateway probe` succeeds)
#   • ready-check      — `openclaw gateway probe`
```

Re-runs are idempotent: setup asks the live Gateway probe first, and a
successful step is recorded in the host's setup ledger so it doesn't
re-run next time. Pass `--force` to re-run anyway. To run setup standalone (after a
`--skip-setup` install or when adding new steps to the adapter):

```bash
agentproto setup openclaw                      # all pending steps
agentproto setup openclaw --only ready-check   # one specific step
```

To bootstrap without agentproto (manual flow):

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
# OR
npm install -g openclaw@latest
openclaw onboard --install-daemon

openclaw gateway probe
openclaw acp
```

For a remote Gateway, pass explicit env vars or flags:

```bash
export OPENCLAW_GATEWAY_URL=wss://gateway-host:18789
export OPENCLAW_GATEWAY_TOKEN=...
openclaw acp --url "$OPENCLAW_GATEWAY_URL"
```

## Spawn

```bash
openclaw acp
# or with explicit flags:
openclaw acp --url wss://gateway-host:18789 --token-file ~/.openclaw/gateway.token
```

The adapter sets `OPENCLAW_HIDE_BANNER=1` and `OPENCLAW_SUPPRESS_NOTES=1`
on spawn to keep the stdio channel free of decorative output. The
runtime itself sets `OPENCLAW_SHELL=acp`.

## Auth

| Env var                         | Purpose                                           |
|---------------------------------|---------------------------------------------------|
| `OPENCLAW_GATEWAY_URL`          | Gateway WebSocket URL (`wss://…`)                 |
| `OPENCLAW_GATEWAY_TOKEN`        | Bearer token for the gateway session              |
| `OPENCLAW_GATEWAY_PASSWORD`     | Alternative password-based auth                   |

If both `OPENCLAW_GATEWAY_TOKEN` and a persisted config exist, the
env var wins. Underlying provider keys (Anthropic, OpenAI, …) are
configured *inside* OpenClaw via `openclaw config` — they are not
read directly by the bridge.
