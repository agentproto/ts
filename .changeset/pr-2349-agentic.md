---
"@agentproto/cli": patch
---

Keep the optional native `canvas` peer external in the `@agentproto/cli` bundle so a workspace where `canvas` is installed but not compiled no longer fails the build through `linkedom`'s guarded `require("canvas")`. The guarded require now resolves (or falls back to linkedom's shim) at load time instead of tsup bundling `canvas/lib/bindings.js` and failing on the missing `canvas.node`.
