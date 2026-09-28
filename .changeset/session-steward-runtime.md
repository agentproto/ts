---
"@agentproto/runtime": minor
---

feat(runtime): session steward runtime — wrap-up plan, per-session RAM, close with outcome. Adds `processTreeRss` (per-session process-tree RSS via `ps`) and `session_list`'s `withMemory` input; `planSessionWrapup`, a deterministic (zero-LLM) close/stuck/judge/keep classifier for idle agent-cli sessions; `SessionOutcome` Level 2 fields (`source: "judged" | "declared"`, `verdict`, `judgedBy`, `note`) alongside two new `SessionEndReason` values (`steward-completed`, `steward-abandoned`); `registry.closeWithOutcome` (verdict `"done"`/`"abandoned"` closes the session lazy-resumably, `"blocked"`/`"needs-input"` records `SessionDescriptor.wrapupFlag` instead without touching liveness); and the `session_wrapup_plan` / `session_wrapup_apply` MCP tools. The judge-agent workflow for the ambiguous class is a separate follow-up.
