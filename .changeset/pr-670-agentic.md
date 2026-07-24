---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Add usage rollup feature for tracking spend estimates over rolling windows.

- New `usage_rollup` MCP tool and `GET /usage/rollup` REST route for querying spend by profile, model, and harness
- New CLI command `agentproto usage rollup` for local-derived, provider-agnostic spend estimates
- Pure rollup logic (`parseWindow`, `rollupUsage`) correctly handles cumulative snapshots and separates priced vs unpriced tokens
- Supports both shorthand (`5h`, `7d`) and ISO-8601 duration formats (`P7D`, `PT5H`)
