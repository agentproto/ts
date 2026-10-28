---
"@agentproto/cli": patch
---

`@agentproto/cli` no longer fails to build in a pnpm workspace where the optional native `canvas` is installed but not compiled (for example one that sets `canvas: false` in `allowBuilds`). `canvas` is an optional peer of `linkedom`, which the bundled runtime reaches through `defuddle`; linkedom loads it inside a `try`/`catch` with a shim fallback, so it is now kept external and the guarded `require("canvas")` runs at load time instead of tsup bundling `canvas/lib/bindings.js` and stopping on the missing `canvas.node`.
