---
"@agentproto/apps": minor
"@agentproto/cli": minor
"@agentproto/runtime": minor
---

New `session-steward` built-in app: a workflow that classifies idle agent sessions, closes rule-certain ones, judges the ambiguous ones (Jev when `JEV_API_KEY` resolves, else a one-shot agent judge), and closes or flags only confident verdicts — a dry run by default. `@agentproto/cli` adds the `agentproto steward` command over it. `@agentproto/runtime` adds the read-only `session_evidence` and `session_judge_jev` MCP tools plus the exported `jev-client` and `session-evidence` modules behind them.
