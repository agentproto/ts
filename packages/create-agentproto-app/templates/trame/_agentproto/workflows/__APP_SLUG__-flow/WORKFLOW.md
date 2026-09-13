---
id: __APP_SLUG__-flow
name: __APP_NAME__ flow
description: >-
  Minimal trame: one harness-pinned agent step (prompt loaded from
  prompts/run.md) followed by ONE deterministic gate. Replace the steps —
  keep the shape: agent work, then mechanical gating.
version: 0.1.0
inputs: {}
outputs: {}
steps:
  - id: run-agent
    kind: agent
    name: Agent step
    description: >-
      The agent does the work. The harness pins model/effort/role; the
      prompt comes from prompts/run.md (the file wins over an inline
      prompt). Replace this step's real task — keep the harness block.
    adapter: claude-code
    prompt: placeholder — prompts/run.md wins over this inline prompt
    harness:
      model: anthropic/claude-sonnet-5
      effort: medium
      role: executor
      promptFile: prompts/run.md
    timeout_ms: 600000

  - id: example-gate
    kind: gate
    name: Example gate
    description: >-
      ONE deterministic gate (exit 0 = pass; its JSON stdout report binds at
      $steps.example-gate.report/.ok/.exitCode). Replace with the app's real
      gate command; the cwd is the app root.
    command: node
    args:
      - gates/example.mjs
    cwd: .
    timeout_ms: 120000
---

Minimal two-step trame for __APP_NAME__: agent work (harness-pinned, prompt
from `prompts/run.md`), then one mechanical gate (`gates/example.mjs`). A
failing gate is a failed run — add `on_fail.reprompt` only once the rework
loop is deliberate.
