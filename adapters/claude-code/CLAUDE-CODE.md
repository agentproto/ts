---
name: claude-code
id: claude-code
description: Anthropic's Claude Code wrapped as an ACP agent via @agentclientprotocol/claude-agent-acp. Spawns the wrapper as `npx @agentclientprotocol/claude-agent-acp` and drives Claude Code over stdio JSON-RPC. Use when an operator should run inside Claude Code's agent loop instead of in-process.
version: 0.1.0
bin: npx
bin_args: ["-y", "@agentclientprotocol/claude-agent-acp"]
install:
  - method: npm
    package: "@agentclientprotocol/claude-agent-acp"
    global: true
version_check:
  cmd: npm view @agentclientprotocol/claude-agent-acp version
  parse: "(\\d+\\.\\d+\\.\\d+)"
  range: ">=0.30.0"
  timeout_ms: 15000
auth:
  ref: ./SECRETS.md
  state:
    env: [ANTHROPIC_API_KEY]
sandbox: ./SANDBOX.md
protocol: acp
acp: ./claude-code-acp.ACP.md
session:
  mode: persistent
  idle_timeout_ms: 1800000
  context_carryover: true
models:
  default: claude-sonnet-4-6
  allowed:
    - claude-sonnet-4-6
    - claude-opus-4-7
    - claude-haiku-4-5
  env:
    anthropic: ANTHROPIC_API_KEY
capabilities:
  streaming: true
  tool_calls: true
  sub_agents: false
  file_io: true
  # Claude Code's ACP wrapper announces `promptCapabilities.image: true`
  # — image content blocks in the user prompt flow through to the
  # underlying Anthropic Messages API as native vision content. See
  # `@agentclientprotocol/claude-agent-acp` v0.30+. Hosts that take
  # advantage of this should send `{type: "image", data, mimeType}`
  # blocks alongside the text in `session.send`.
  multimodal: true
  # The wrapper (@agentclientprotocol/claude-agent-acp >= 0.30) advertises
  # `loadSession: true` over ACP — newSession/loadSession/resumeSession
  # are all wired. The host pairs this with the `native-resume`
  # continuation strategy below to reattach to an existing session
  # across cold starts (API restart, sandbox reap, multi-machine).
  resumable: true
  bidirectional: true
modes:
  - id: default
    description: Standard interactive mode with per-tool permission prompts.
  - id: lean
    description: >-
      Drop Claude Code's bundled skills and workflows from context (built-in
      slash commands stay typable but are hidden from the model). Plugins,
      project `.claude/skills/`, and `.claude/commands/` are unaffected. The
      wrapper has no CLI flag for this — the underlying `claude` binary reads
      `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS` directly, so this mode is env-only.
    env:
      CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1"
  - id: plan
    description: Plan-only mode — Claude Code reasons and proposes but does not edit or run commands.
    bin_args_append: ["--permission-mode", "plan"]
  - id: accept-edits
    description: Auto-accept file edits; commands still prompt.
    bin_args_append: ["--permission-mode", "acceptEdits"]
  - id: bypass-permissions
    description: Skip all permission prompts. Use only in trusted automation contexts.
    bin_args_append: ["--permission-mode", "bypassPermissions"]
options:
  - id: model
    type: enum
    enum: [claude-sonnet-4-6, claude-opus-4-7, claude-haiku-4-5]
    description: Override the default model for this operator binding.
    bin_args_template: ["--model", "{value}"]
  - id: max_turns
    type: integer
    min: 1
    max: 200
    description: Hard cap on tool-use turns within a single send. Claude Code stops after this many cycles.
    bin_args_template: ["--max-turns", "{value}"]
continuation:
  # `native-resume` is the right default now that the wrapper supports
  # `loadSession`: each turn cold-spawns claude with no overhead, then
  # reattaches to the saved session id via ACP loadSession. Survives
  # API restarts, sandbox reaps, and machine swaps because the session
  # state lives in claude's own JSONL store at the agent's chosen
  # storage location (CLAUDE_CONFIG_DIR-controlled).
  #
  # `pinned-session` is kept as a supported fallback for hosts that
  # haven't wired the native-resume hooks yet — same warm-process
  # behaviour as before, lost on process restart.
  default: native-resume
  supported: [native-resume, pinned-session, transcript, none]
  pinned_session:
    idle_timeout_ms: 1800000
    key_scope: [conversation, operator]
tags: [claude-code, anthropic, acp, agent-runtime, coding]
---

# Claude Code

Anthropic's coding agent driven over ACP via the
[`@agentclientprotocol/claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp)
wrapper.

## When to use this manifest

Bind an AIP-9 operator to Claude Code when the operator should run as
Anthropic's coding agent (file ops, command execution, planning) under
operator governance. Common cases: dev-tooling operators, code-review
operators, refactor-on-demand operators.

## Install

The wrapper is an npm package — `npm install -g @agentclientprotocol/claude-agent-acp`,
then it's reachable on PATH. The manifest invokes it via `npx -y` so a
fresh install isn't strictly required if `npx` is available.

## Auth

Claude Code reads `ANTHROPIC_API_KEY` at boot. The runner forwards it
via `sandbox.env.set` (never argv).
