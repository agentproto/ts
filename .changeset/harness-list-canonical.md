---
"@agentproto/runtime": minor
"@agentproto/app-client": minor
"@agentproto/cli": patch
---

Add the canonical `harness_list` MCP tool. It shares `adapter_list`'s lister, compact/full projection, `{ adapters }` envelope, pagination, `fields` and truncation behaviour, and accepts `harness` (canonical) or `adapter` (legacy alias); naming both with different values is a clear validation error. `adapter_list` keeps its existing schema and payload byte-for-byte for older clients, and old daemons keep serving it. `harness_list` is classified full-only like `adapter_list` (no widening of named profiles or scoped-link tokens), while `APP_UI_DISCOVERY_TOOLS` — owned by `@agentproto/app-client` — gains `harness_list` alongside the legacy name. Consumer clients (Runner Select, Studio, VS Code) stay on `adapter_list` in this delivery.
