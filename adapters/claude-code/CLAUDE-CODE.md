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
  multimodal: false
  resumable: false
  bidirectional: true
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
