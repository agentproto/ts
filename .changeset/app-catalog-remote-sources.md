---
"@agentproto/runtime": patch
---

`app_catalog` now merges remote catalog sources: `catalog.sources` in the daemon config (or `sources` in `~/.agentproto/app-catalog.json`; config wins) lists URLs returning `{ entries: AppCatalogEntry[] }`. Remote entries are appended after local ones, deduped by `appId`, and carry a `source` (git or `.agentapp`) for `app_install`. Results are cached for 5 minutes (`app_catalog { refresh: true }` bypasses); a failing source is reported in a trailing `{ warnings }` content block instead of failing the tool.
