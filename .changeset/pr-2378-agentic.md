---
"@agentproto/runtime": minor
---

Refuse a tool call at dispatch when the calling session's AGENT manifest denies it: the deny grants of the manifest's `tools` items are recorded on the session descriptor (`toolDenyGrants`, additive and optional), carried across restart and continue-fresh, and evaluated deny-only (default allow) by the `/mcp` built-in tool gate and the imported-call guard. Adds `@agentproto/operator` as a runtime dependency for the deny-grant helper.
