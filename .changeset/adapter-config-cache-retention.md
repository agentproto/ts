---
"@agentproto/harness": minor
"@agentproto/runtime": minor
"@agentproto/cli": minor
"@agentproto/adapter-opencode": patch
---

Stop per-session adapter config dirs (`~/.agentproto/adapter-config/<id>`) from growing without bound. When a spawn redirects a base dir (opencode's credential `XDG_DATA_HOME`), the tool caches known to derive from it (pnpm store, uv managed Pythons) are now symlinked to the operator's own location instead of being rebuilt per session; confined spawns keep per-session caches. The driver records each dir's disposable paths in `.agentproto-cache.json` (`credentialDataHome.disposable`; opencode lists `snapshot`, `tool-output`, `log`), and a new adapter-cache sweep deletes them once every session of the lineage is dead and quiet for `daemon.adapterCacheRetentionDays` (default 1), keeping the resume store. Runs with the periodic retention sweep, and on demand via `session_gc adapterCaches:true` and `agentproto sessions gc --adapter-caches`.
