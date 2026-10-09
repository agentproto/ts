---
"@agentproto/runtime": patch
---

MCP Events webhook deliveries are now observable: one log line per delivery attempt (sentinel, event, callback host only, HTTP status or redacted error, attempt, final delivered/dead), and `sentinel_list` / `GET /sentinels` report a per-sentinel `deliveryStatus` (`active`, `lastDeliveryAt`, `lastStatus`, `lastError`, `attempts`, `dead`). URL paths, tokens, bodies and secrets never reach logs or status. The `events/subscribe` result is unchanged.
