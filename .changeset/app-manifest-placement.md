---
"@agentproto/app-kit": patch
---

APP.md gains optional `placement`, `requires` (object form: browser/fs/gpu/secrets/apps; the flat app-id array still works), `exposes` and `accepts` keys, validated in `defineApp` and `loadAppHandle`, surfaced on `AppHandle`, and round-tripped by `emit`. Semantics only; no scheduling behavior.
