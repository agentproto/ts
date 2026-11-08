---
"@agentproto/runtime": patch
---

`agent_start` with `cloud` no longer fails with "mcpServers is not supported for managed cloud agents". The daemon's own `agentproto` gateway mount (and the report-back, bundle, `daemonMount` and browser defaults) is skipped silently for a managed cloud spawn, since the vendor owns the harness (AIP-66 section 4). An explicit `mcpServers`, `bundles`, `daemonMount`, `browser` or `appServe` is still refused by name, and an explicit `orchestrator` is ignored with a warning rather than reaching the adapter as an MCP mount.
