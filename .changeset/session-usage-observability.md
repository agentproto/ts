---
"@agentproto/runtime": minor
"@agentproto/acp": minor
---

Per-session usage observability: cost + tokens, live and durable.

- `session_list` / `agent_sessions_list` now project each session's `costUsd`,
  `tokensIn`, `tokensOut`, and the latest `contextSize` / `contextUsed`
  (omitted when absent — never emitted as measured zeros), plus a
  `usageSource` discriminator.
- New `session_usage({ idOrName })` MCP tool returns
  `{ model, costUsd?, tokensIn?, tokensOut?, contextSize?, contextUsed?, source }`.
- ACP adapters (claude-code, mastracode) that report token counts but no cost
  are now priced against agentproto's in-repo LLM catalog
  (`costUsd = tokensIn·priceIn + tokensOut·priceOut`), tagged
  `source: "computed"`. When the model is absent from the catalog the cost is
  left undefined and tagged `source: "no-pricing"` — a price is never
  fabricated. Adapter-reported costs are tagged `source: "adapter"`.
- A durable `usage_snapshot` record is written to the session transcript at
  each turn-end and on session exit, so cumulative usage survives a daemon
  restart and is aggregable after the fact.
- ACP `usage_update` events now also carry optional `tokensIn` / `tokensOut`
  when the agent reports them.
