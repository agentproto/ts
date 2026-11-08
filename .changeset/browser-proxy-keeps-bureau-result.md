---
"@agentproto/runtime": patch
---

The daemon `browser_*` proxy no longer hides Bureau's answer behind its deprecation marker. When Bureau's result has no `structuredContent`, none is created (clients that read it first showed only `{deprecated, notes}`); the marker moves to `_meta["agentproto/deprecated"]` plus a trailing text block, and the notice is reworded so it cannot be read as "Bureau is not mounted".
