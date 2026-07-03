---
"@agentproto/runtime": patch
"@agentproto/driver-agent-cli": patch
---

Emit `usage_update` transcript events for non-claude adapters (P3, #186)

Previously only claude-code emitted `usage_update` events into the unified
`events.jsonl` transcript, so hermes and mastracode sessions carried no
token/context telemetry there.

- **hermes**: the turn-end path now records a `usage_update` from its
  `readUsage` (state.db) reader — same envelope claude-code emits over ACP
  (`size`/`used` + cumulative `tokensIn`/`tokensOut` + optional `cost`). Only
  when the reader actually returns a signal; never fabricated.
- **mastracode (print + in-process)**: the shared Mastra event mapper now maps
  Mastra Code's native `usage_update` controller event
  (`{ usage: { promptTokens, completionTokens } }`) to a `usage_update`
  StreamEvent — mastracode *does* expose usage, so it is mapped, not fabricated.
- The transcript writer now persists `tokensIn`/`tokensOut` on `usage_update`
  records for every adapter that reports them.
