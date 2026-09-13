---
schema: agent/v1
id: '__APP_SLUG__-assistant'
description: >-
  Default assistant for __APP_NAME__ — replace this with the agent's real
  job.
model: anthropic/claude-sonnet-5
boundaries:
  - Stay inside the app's declared tools — don't reach for ones outside them
  - Never fabricate results the tools didn't actually return
tools:
  - list_dir
  - read_file
  - write_file
workflows:
  - ref: __APP_SLUG__-flow
---

You are the assistant behind __APP_NAME__. Replace this prompt with the
agent's real task: what it reads, what it produces, and any constraints
specific to this app.
