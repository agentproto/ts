---
"@agentproto/runtime": minor
---

feat(runtime): sentinel primitive (AIP-60 step 1/2) — persisted watch registry (`sentinel-store`), poll/delivery engine (`sentinel-runtime`), pluggable provider contract + registry, GitHub webhook → CloudEvents normalizer, and `list_sentinel_adapters` / `setup_sentinel_provider` MCP tools. No built-in provider ships yet; the feature is inert until a sentinel exists on disk or a third-party provider package is installed.
