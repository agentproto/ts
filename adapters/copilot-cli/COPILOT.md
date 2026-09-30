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
  multimodal: false
  resumable: true
  bidirectional: true
tags: ["copilot", "github", "acp", "agent-runtime", "coding", "enterprise"]
---

# GitHub Copilot CLI adapter

`@agentproto/adapter-copilot-cli` wraps GitHub's official **Copilot CLI**
(binary `copilot`, GitHub: `github/copilot-cli`, docs:
<https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli>)
as an AIP-45 agent CLI by spawning `copilot --acp --stdio` — the CLI's own
first-party ACP-over-stdio server.

## Why ACP, not a print bridge

GitHub Copilot CLI ships a first-party Agent Client Protocol server
(`copilot --acp`, stdio by default; `--acp --port N` for TCP). ACP support was
added in **0.0.397** (2026-01-28) and is in public preview. The server speaks
NDJSON JSON-RPC 2.0 over stdio, exposes **model** and **reasoning-effort** ACP
session config options, and supports **loading existing sessions** (0.0.410+).

The CLI also has a headless one-shot mode — `copilot -p "<prompt>"
--output-format json` emits JSONL, with `--model`, `--resume[=ID]`,
`--allow-all-tools`, and `--stream` — but ACP is the richer, persistent,
resumable posture, so this adapter drives ACP. It avoids a bespoke print event
mapper in `@agentproto/driver-agent-cli` (whose `event_schema` enum is closed).

## Install

Any of the official channels works; the adapter declares all three:

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

The model menu is plan/entitlement-dependent and served under one GitHub
identity, and the exact `--model` slugs are not published in a stable table, so
this adapter declares **no fixed `models.allowed`**. Pass any id from the CLI's
`/model` picker through the free-form `model` option (e.g. `claude-sonnet-4.5`,
`gpt-5`, `auto`); it is applied via the ACP `model` session config option and
validated by the CLI against your account.

## What's verified vs. assumed

**Verified from the official docs** (2026-10-01): the `copilot` binary name,
the `--acp --stdio` ACP surface and its stdio/TCP transports, the ACP server's
model + effort config options and session-load support, the token env
precedence and token types, the Enterprise host/token variables, and the
`-p --output-format json` headless surface.

**Not live-verified** (the `copilot` binary is not installed in this worktree):
the exact `copilot --version` stdout shape (the semver parse is conventional),
the precise ACP config-option ids (`model`/`effort` are assumed from the
changelog's "ACP model/effort session config options"), and the ACP
`promptCapabilities` (multimodal declared `false` conservatively).
