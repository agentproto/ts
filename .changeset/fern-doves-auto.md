---
"@agentproto/cli": minor
"@agentproto/runtime": minor
"@agentproto/sentinel": minor
---

Sentinel signal routing, shadow only: a `sentinel.routes` rule table (match subject/types/from, `via` providers, `fallback`, `do: deliver | forward | drop`, `target`, `mode`) resolved most-specific-first, then list order, with visible `builtin:` defaults; an explicit `provider` still wins. `sentinel_watch` and `POST /sentinels` stamp the decision as `route` on the sentinel and log one line to `~/.agentproto/sentinel-routing.jsonl`, but the provider actually used is unchanged. New read-only `sentinel_routes` MCP tool, `GET /sentinels/routes[/explain]` and `agentproto sentinel routes [list|explain <subject>]`. `sentinel.autoWatchPrs`, `sentinel.autoWatchUrgency`, `sentinel.routes` and `sentinel.routing.mode` are now registered config keys.
