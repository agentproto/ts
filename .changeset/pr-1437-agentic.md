---
"@agentproto/runtime": minor
"@agentproto/workflow-runtime": minor
"@agentproto/cli": minor
"@agentproto/adapter-claude-code": minor
"@agentproto/apps": patch
"@agentproto/worktree": patch
---

repo-maintenance: missing-verdict retry ladder (same-session nudge + large-model retry) via the new read-only `branch_gc_verdict_get` tool (`BranchGcVerdictReader` port); fixed the maintain report's worktree classification counts; `tool_search` option for the claude-code adapter, auto-disabled for allowlisted agent steps; `{{index}}` support in agent-step `sessionRef` for fan-out session reuse; step session descriptors now echo the pinned model/effort.
