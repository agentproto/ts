---
"@agentproto/runtime": patch
---

`app_run` without an explicit `adapter`/`harness` now resolves each agent's adapter like workflow agent refs do (AGENT.md `metadata.adapter`/`metadata.harness`, then `claude-*` model → `claude-code`, then `mastra-agent`), so A2A `SendMessage` tasks are no longer forced onto mastra-agent.
