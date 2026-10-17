---
"@agentproto/app-kit": minor
"@agentproto/runtime": patch
---

`@agentproto/app-kit` adds newly exported `parseServiceList` (and its `ServiceListResult` type) — a non-throwing wrapper around the `services:` manifest validator shared with `defineApp`/`loadAppHandle`, so callers outside the throw-based `normalizeManifestFields` flow get the same rule set.

`@agentproto/runtime`'s `parseAppServices` now delegates to app-kit's `parseServiceList` instead of carrying its own duplicate validator, unifying the two previously-divergent `services:` rule sets. Install-time validation tightens accordingly (leading-letter names, no unknown object fields, fail-fast on the first bad entry, and an explicitly-present empty `services: []` is rejected).
