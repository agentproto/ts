---
"@agentproto/runtime": patch
---

`agent_start` with `cloud` no longer fails with "mcpServers is not supported for managed cloud agents". The daemon's own `agentproto` gateway mount (and the report-back, bundle, `daemonMount` and browser defaults) is skipped silently for a managed cloud spawn, since the vendor owns the harness (AIP-66 section 4). An explicit `mcpServers`, `bundles`, `daemonMount` or `browser` is still refused by name.
