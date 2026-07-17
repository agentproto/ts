---
name: Agentproto lane smoke test
id: agentproto-lane-smoke
description: One-step smoke test proving the agentproto-run composite action can boot a daemon, drive a WORKFLOW.md over MCP, and get a real agent reply back.
version: 0.1.0
entry: ./entry.mjs
inputs: {}
outputs: {}
steps:
  - id: reply-ok
    kind: agent
    adapter: claude-code
---

# Agentproto lane smoke test

The manifest mirrors the entry's step graph for governance (AIP-15
`reconcileEntry`); the entry (`entry.mjs`) is the source of truth for the
runtime `agent` step, which is only reachable via an entry module.

Spawns a single `claude-code` session and asks it to reply with exactly the
word `OK` — proof the `agentproto-run` action can boot a daemon, load this
file through `workflow_run_file` over MCP, and drive a real agent turn to
completion.
