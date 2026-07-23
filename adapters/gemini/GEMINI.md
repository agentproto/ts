---
name: gemini
id: gemini
description: Google's Gemini CLI in ACP mode (`gemini --experimental-acp`) — an open-source terminal agent driving Gemini models over the Agent Client Protocol via stdio JSON-RPC. Native adapter (over the generic `gemini-cli` catalog entry) so subscription billing-auth — "use my existing Gemini login" — is a verified, money-safe opt-in.
version: 0.1.0
bin: gemini
bin_args: ["--experimental-acp"]
install:
  - method: npm
    package: "@google/gemini-cli"
    global: true
version_check:
  cmd: gemini --version
  parse: "(\\d+\\.\\d+\\.\\d+)"
  range: ">=0.1.0"
  timeout_ms: 15000
auth:
  ref: ./SECRETS.md
  state:
    env: [GEMINI_API_KEY, GOOGLE_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY]
provider: google
authSubscription:
  external: true
  conflictEnv: [GEMINI_API_KEY, GOOGLE_API_KEY]
sandbox: ./SANDBOX.md
protocol: acp
acp: ./gemini-acp.ACP.md
session:
  mode: persistent
  idle_timeout_ms: 1800000
  context_carryover: true
models:
  default: gemini-2.5-pro
  allowed:
    - gemini-2.5-pro
    - gemini-2.5-flash
    - gemini-2.5-flash-lite
    - gemini-3.5-flash
    - gemini-3.1-pro-preview
    - gemini-3-flash-preview
    - gemini-3.1-flash-lite
  env:
    google: GOOGLE_GENERATIVE_AI_API_KEY
    gemini: GEMINI_API_KEY
  apply: arg
  bin_args_template: ["-m", "{model}"]
capabilities:
  streaming: true
  tool_calls: true
  sub_agents: false
  file_io: true
  multimodal: true
  resumable: true
  bidirectional: true
tags: ["gemini", "google", "acp", "agent-runtime", "coding"]
---

# Gemini adapter

`@agentproto/adapter-gemini` wraps Google's open-source **Gemini CLI** as an
AIP-45 agent CLI by spawning it in ACP mode (`gemini --experimental-acp`) and
driving it over stdio JSON-RPC.

## Why a native adapter (vs the generic `gemini-cli` entry)

The generic ACP catalog already knows how to spawn `gemini --experimental-acp`,
but a catalog entry carries no `provider` and no `authSubscription`, so it's
pure-ambient — the daemon can't verify or guarantee which billing rail a spawn
uses. This native adapter adds the billing-auth surface: a catalog `provider`
(`google`) and a file-based (external) subscription so **"use my existing Gemini
login"** is an explicit, verified, money-safe opt-in.

## Install

```bash
npm install -g @google/gemini-cli
```

`--experimental-acp` starts ACP mode. Current Gemini CLI builds prefer the
shorter `--acp`; the experimental spelling is kept as a working alias and
matches the rest of the ACP catalog.

## Auth

Gemini authenticates one of three ways:

| Mechanism        | How                                                       |
|------------------|-----------------------------------------------------------|
| Existing login   | The CLI's own OAuth login (`~/.gemini/oauth_creds.json`)  |
| Gemini API key   | `GEMINI_API_KEY=…`                                        |
| Google API key   | `GOOGLE_API_KEY=…` / `GOOGLE_GENERATIVE_AI_API_KEY=…`     |

### "Use my existing Gemini login" (file-based subscription)

`authSubscription: { external: true }`. The Gemini CLI reads its own
`~/.gemini/oauth_creds.json`, so the daemon injects **nothing** — it verifies
the login is present (fail-loud) and **scrubs** every api-key var
(`GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`) so a stray
key can't silently flip the spawn to per-token API billing. An env API key
*overrides* the OAuth login in Google's precedence, which is exactly why all
three are scrubbed. Money-safe by construction: no OAuth bearer is ever written
into an api-key env var, because no bearer is injected at all.
