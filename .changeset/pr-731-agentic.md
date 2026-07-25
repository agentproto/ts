---
"agentproto-vscode": patch
---

Support pinned `@route` suffixes in model references: enhance `currentRouteOf()` to prioritize the model ref's own explicit route over a stale `route.gateway` field, ensuring correct eligibility checks and profile selection when the same model is reachable via multiple billing endpoints.
