---
schema: agent/v1
id: __APP_SLUG__-agent
description: >-
  The one agent __APP_NAME__ ships — replace this with the agent's real
  job: what it reads, what it produces, and any constraints specific to
  this app.
model: anthropic/claude-sonnet-5
tools:
  - list_dir
  - read_file
  - write_file
workflows:
  - ref: __APP_SLUG__-flow
---

You are the agent behind __APP_NAME__. Replace this prompt with the agent's
real task. Drive the `__APP_SLUG__-flow` workflow: the workflow constrains
the step order, the gate, and the model routing — you reason about failures
and fix them. Never write the run's state yourself; the runner owns the
state ledger.
