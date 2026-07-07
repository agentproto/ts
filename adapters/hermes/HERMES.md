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
  default: z-ai/glm-5.2
  allowed:
    - z-ai/glm-5.2
    - deepseek/deepseek-v4-pro
    - meta-llama/llama-3.3-70b
    - openai/gpt-4
  # Anthropic models are reserved for the dedicated claude-code adapter —
  # hermes must NEVER route to them, even if a caller passes the id
  # explicitly. Enforced at compose time (RuntimeConfigError).
  deny:
    - anthropic/*
    - claude-*
  env:
    openrouter: OPENROUTER_API_KEY
    openai: OPENAI_API_KEY
  # hermes keeps its own configured default when given a model via the ACP
  # session config — selection must go through a `/model <id>` control turn
  # instead. See the "Model selection" section below.
  apply: command
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
  - id: model
    type: string
    description: >-
      Model ID routed through OpenRouter/OpenAI (e.g.
      'deepseek/deepseek-v4-pro', 'z-ai/glm-5.2', 'moonshotai/kimi-k2').
      Free-form: any valid OpenRouter/OpenAI id is accepted even when not
      in `allowed`. Anthropic models are denied (see `models.deny`) — use
      the claude-code adapter for those. Applied via a `/model <id>`
      control turn after the session is created (hermes ignores the ACP
      session model config). Omit to use the hermes default.
  - id: effort
    type: enum
    enum: [low, medium, high, xhigh, max]
    description: >-
      Reasoning effort level passed to hermes via ACP newSession. Omit to
      use the hermes default.
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

## Model selection

Hermes does **not** read the model from its ACP session config — it keeps
whatever its own `~/.hermes/config.yaml` resolves as default. So unlike the
claude-code / claude-sdk adapters (which pin the model at spawn via a CLI
flag), the `model` option here is applied as a **`/model <id>` control turn
sent after the session is created** (`models.apply: command`).

Two consequences an operator should know:

- **Provider is whatever hermes resolves at session start.** The `/model`
  turn only switches the model id; it does not re-resolve the provider. If
  `~/.hermes/config.yaml`'s default provider is `moa` (Mixture of Agents),
  a `/model moonshotai/kimi-k2` turn targets a model moa can't serve and
  fails. Point hermes at the right provider (e.g. set
  `model.default.provider: openrouter`, or a direct `moonshot` provider
  block) before relying on the `model` option. The interactive CLI
  `hermes --model <id>` resolves the provider at launch and does not have
  this constraint.
- **No `provider` option is exposed.** Agentproto can only set the model
  id, not force OpenRouter/Moonshot routing. To run Kimi through a
  provider-pinned path, prefer the `claude-sdk` adapter with
  `mode: moonshot` (or `mode: openrouter` + a model slug).

`models.deny` (`anthropic/*`, `claude-*`) is enforced at compose time — a
RuntimeConfigError — so the budget arm can never silently burn premium
Anthropic spend.

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
