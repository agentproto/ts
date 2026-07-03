---
name: hermes
id: hermes
description: Nous Research's Hermes Agent — autonomous CLI agent with skills, sandboxes, memory plugins, and a built-in ACP server. Spawned as `hermes acp` and driven over stdio JSON-RPC; per-turn streaming via ACP session/update notifications. Use when an operator wants the Hermes runtime as its execution surface (multimodal, multi-provider, agentskills.io-compatible).
version: 0.1.0
bin: hermes
bin_args: [acp]
install:
  - method: curl
    url: https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh
  - method: brew
    package: hermes-agent
    experimental: true
version_check:
  cmd: hermes --version
  parse: "(\\d+\\.\\d+\\.\\d+)"
  range: ">=0.13.0 <1.0.0"
  timeout_ms: 5000
auth:
  ref: ./SECRETS.md
  state:
    env: [OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY]
sandbox: ./SANDBOX.md
protocol: acp
acp: ./hermes-acp.ACP.md
session:
  mode: persistent
  idle_timeout_ms: 1800000
  context_carryover: true
models:
  default: anthropic/claude-sonnet-4-6
  allowed:
    - anthropic/claude-sonnet-4-6
    - anthropic/claude-opus-4-7
    - openai/gpt-4
    - meta-llama/llama-3.3-70b
  env:
    anthropic: ANTHROPIC_API_KEY
    openrouter: OPENROUTER_API_KEY
    openai: OPENAI_API_KEY
capabilities:
  streaming: true
  tool_calls: true
  sub_agents: true
  file_io: true
  multimodal: true
  resumable: false
  bidirectional: true
modes:
  - id: default
    description: Standard interactive mode — loads ~/.hermes/config.yaml and auto-injects rules/memory/preloaded skills as usual.
  - id: lean
    description: >-
      Skip ~/.hermes/config.yaml, cutting the skills/rules/memory scaffolding
      hermes would otherwise preload into context. Composed as
      `hermes --ignore-user-config acp` — the global flag MUST precede the
      `acp` subcommand baked into `bin_args`, which is why this needs
      `bin_args_prepend` rather than `bin_args_append`.
    bin_args_prepend: ["--ignore-user-config"]
options:
  - id: skills
    type: string
    description: >-
      Preload one or more agentskills.io-compatible skills for the session
      (comma-separate for multiple), via hermes' `--skills` global flag.
      Same prepend-before-`acp` constraint as the `lean` mode.
    bin_args_prepend: ["--skills", "{value}"]
tags: [hermes, nous, acp, agent-runtime]
---

# Hermes Agent

Nous Research's open-source autonomous agent CLI. Implements the
Agent Client Protocol server-side, exposing its agent loop —
skills (agentskills.io-compatible), tools, sandboxed subagents,
plugin-based memory (Honcho, mem0, supermemory, …), and
multi-provider model routing — over stdio JSON-RPC.

## When to use this manifest

Bind an AIP-9 operator to Hermes when the operator should run inside
Hermes' agent loop instead of in-process. Common cases: surfacing
the Guilde / Katchy operator inside an IDE Shell view (M5), running
a power-user-style agent CLI under operator governance, or letting
the operator delegate to Hermes-native skills the host doesn't ship.

## Auth

Hermes consumes per-provider API keys via environment variables.
[`./SECRETS.md`](./SECRETS.md) inventories the slots; values are
resolved from the operator's secret store and passed via
`sandbox.env.set` (never argv). At minimum one of
`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY` MUST
be present at boot.

## Protocol

`protocol: acp` — Hermes ships an ACP server in
[`acp_adapter/`](https://github.com/NousResearch/hermes-agent/tree/main/acp_adapter).
The `[hermes-acp.ACP.md](./hermes-acp.ACP.md)` sidecar (AIP-44)
declares the wire profile this manifest binds to.

## Sandbox

[`./SANDBOX.md`](./SANDBOX.md) declares a `local` provider for dev.
Production deployments swap to `mastra-modal` / `mastra-daytona` for
process isolation; the runner change is one field, no driver edits.

## Versioning

Hermes pre-1.0 versions API surface frequently. The
`version_check.range` pin is conservative (`>=0.13.0 <1.0.0`). Bump
the manifest's `version` whenever Hermes ships a behaviour or
protocol change that affects this binding.
