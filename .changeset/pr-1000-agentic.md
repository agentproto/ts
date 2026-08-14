---
"@agentproto/runtime": patch
---

Enhance PR provenance with exact attribution from tool-call records. The reconciler now checks two lanes in order: lane A reads successful `gh pr create` calls from the session's transcript (immune to branch switches and shared checkouts), then falls back to lane B (branch→PR resolution) for adapters whose tool calls aren't recorded.
