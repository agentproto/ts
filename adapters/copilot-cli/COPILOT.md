---
name: copilot-cli
id: copilot-cli
description: GitHub's official Copilot CLI (`copilot --acp --stdio`) — a terminal coding agent driving GitHub-hosted models over the Agent Client Protocol. Public github.com and GitHub Enterprise (GH_HOST).
version: 0.1.0
bin: copilot
bin_args: ["--acp", "--stdio"]
install:
  - method: npm
    package: "@github/copilot"
    global: true
  - method: brew
    package: copilot-cli
  - method: curl
    url: "https://gh.io/copilot-install"
version_check:
  cmd: copilot --version
  parse: "(\\d+\\.\\d+\\.\\d+)"
  range: ">=0.0.410"
  timeout_ms: 15000
auth:
  ref: ./SECRETS.md
  state:
    env:
      - COPILOT_GITHUB_TOKEN
      - GH_TOKEN
      - GITHUB_TOKEN
      - GH_ENTERPRISE_TOKEN
      - GITHUB_ENTERPRISE_TOKEN
sandbox: ./SANDBOX.md
protocol: acp
acp: ./copilot-acp.ACP.md
session:
  mode: persistent
  idle_timeout_ms: 1800000
  context_carryover: true
capabilities:
  streaming: true
  tool_calls: true
  sub_agents: false
  file_io: true
  multimodal: true
  resumable: true
  bidirectional: true
tags: ["copilot", "github", "acp", "agent-runtime", "coding", "enterprise"]
---

# GitHub Copilot CLI harness

`@agentproto/adapter-copilot-cli` wraps GitHub's official **Copilot CLI**
(binary `copilot`, GitHub: `github/copilot-cli`, docs:
<https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli>)
as an AIP-45 agent CLI by spawning `copilot --acp --stdio` — the CLI's own
first-party ACP-over-stdio server.

## Why ACP, not a print bridge

GitHub Copilot CLI ships a first-party Agent Client Protocol server
(`copilot --acp`, stdio by default; `--acp --port N` for TCP). ACP support was
added in **0.0.397** (2026-01-28); everything below is verified live on CLI
**1.0.113** (ACP `protocolVersion` 1, 2026-11-18). The server speaks NDJSON
JSON-RPC 2.0 over stdio, exposes **model**, **reasoning-effort** and **mode**
ACP session config options, supports **loading existing sessions** (0.0.410+),
accepts **image** prompts, and speaks **MCP over http and sse**.

The CLI also has a headless one-shot mode — `copilot -p "<prompt>"
--output-format json` emits JSONL, with `--model`, `--resume[=ID]`,
`--allow-all-tools`, and `--stream` — but ACP is the richer, persistent,
resumable posture, so this harness drives ACP. It avoids a bespoke print event
mapper in `@agentproto/driver-agent-cli` (whose `event_schema` enum is closed).

## Install

Any of the official channels works; the harness declares all three:

```bash
npm install -g @github/copilot      # npm
brew install copilot-cli            # Homebrew cask (macOS/Linux)
curl -fsSL https://gh.io/copilot-install | bash   # installer script
```

## Auth — public github.com and GitHub Enterprise

Copilot CLI checks credentials in this order:

1. `COPILOT_GITHUB_TOKEN`
2. `GH_TOKEN`
3. `GITHUB_TOKEN`
4. OAuth token from the system keychain / `~/.copilot/config.json`
5. `gh auth token` fallback

Supported token types: OAuth (`gho_`), fine-grained PAT with the **"Copilot
Requests"** permission (`github_pat_`, owned by a personal account), and GitHub
App user-to-server (`ghu_`). **Classic PATs (`ghp_`) are not supported.**

| Target | How |
|--------|-----|
| github.com | `GH_TOKEN` / `GITHUB_TOKEN` (or `copilot login`) |
| GHEC with data residency | `GH_HOST=example.ghe.com` + a `GH_TOKEN`/`GITHUB_TOKEN`, or `copilot login --host https://example.ghe.com` |
| GitHub Enterprise Server | `GH_HOST=YOUR-GHES-HOSTNAME` + `GH_ENTERPRISE_TOKEN` (or `GITHUB_ENTERPRISE_TOKEN`); the `COPILOT_PROVIDER_GHES_HOST` / `COPILOT_PROVIDER_GHES_TOKEN` / `COPILOT_OFFLINE=true` triple is the disconnected alternative |

The `github_host` option sets `GH_HOST` on the spawn.

### BYOK (no GitHub login)

Copilot CLI can run against an OpenAI-compatible / Azure / Anthropic endpoint
with `COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_TYPE`,
`COPILOT_PROVIDER_API_KEY`, and `COPILOT_MODEL`. Not wired as options here;
pass them through the spawn `env` if you need it.

## Models

The harness ships a curated menu (`models.allowed`) read from a real
`session/new` on 1.0.113: `auto`, `claude-sonnet-5.5` (default),
`claude-sonnet-5`, `claude-haiku-5.5`, `claude-haiku-4.5`, `gpt-6.1-terra`,
`gpt-6-luna`, `gpt-5.6-luna`, `gpt-5.3-codex`, `mai-code-1.1-flash`,
`mai-code-2-flash`, `mai-code-2`, `gemini-3.8-flash`, `gemini-4-hydrogen`,
`grok-4.7`, `grok-4.6`, `kimi-k3`. The menu is plan/entitlement-dependent and
the Copilot CLI charges by premium-request multiplier (e.g. `claude-haiku-4.5`
0.33x, `gemini-3.8-flash` 14x on the tested account), so treat the list as a
menu, not a guarantee: the free-form `model` option still takes any id from the
CLI's `/model` picker, applied via the ACP `model` session config option and
validated by the CLI against your account. The authoritative per-account list is
what the session returns at `session/new` (`models.availableModels` and the
`model` config option).

## Effort

Effort is the `reasoning_effort` ACP config option on Copilot (`low` / `medium`
/ `high` / `xhigh` / `max`). The ACP client resolves the config id from the
options the session advertises (`effort`, then `reasoning_effort`, then the
`thought_level` category), so the `effort` harness option works unchanged.

## Modes

Copilot's `mode` config option offers three modes: `agent` (default), `plan`
and `autopilot` (allow-all, experimental). They come from the session's own
mode registry, so they appear as the session's available modes and are switched
through the standard posture controls.

## Concurrent prompts

The server does not advertise `_meta.steering`. A second `session/prompt` sent
while a turn is running **cancels** the first (`stopReason: cancelled`) and runs
instead. The harness correctly declares no steering, so the daemon queues the
second prompt FIFO rather than sending it raw.

## What's verified

Verified live on CLI 1.0.113 (2026-11-18): `copilot --version` stdout
("GitHub Copilot CLI 1.0.113."), the ACP handshake and capabilities, the
`model` / `reasoning_effort` / `mode` config option ids (`effort` is rejected:
"Unknown config option"), image prompts (`promptCapabilities.image: true`; a PNG
block was described correctly), MCP tool calls, `session/list`, and the token
and keychain login. From the docs only: the Enterprise host/token variables and
the `-p --output-format json` headless surface. Not re-tested: resuming a
session after the process was restarted, and CLIs older than 1.0.x (the
`>=0.0.410` floor is kept).
