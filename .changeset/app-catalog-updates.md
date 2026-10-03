---
"@agentproto/runtime": minor
---

Catalog-tracked updates: `app_install {catalogUrl}` records `source.catalogId`; the new `app_updates` tool reports catalog entries newer than the installed app (different digest/commit, version not lower); `app_resync` on a catalog-tracked app installs its catalog's current entry from the entry's own URL, verified against its digest; `app_catalog` marks such entries `updateAvailable`.
