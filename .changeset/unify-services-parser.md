---
"@agentproto/app-kit": patch
"@agentproto/runtime": patch
---

`@agentproto/app-kit` exports a new `parseServiceList` — a non-throwing wrapper around the `services:` manifest validator already used by `defineApp`/`loadAppHandle` — so callers outside the throw-based `normalizeManifestFields` flow get the same single rule set.

`@agentproto/runtime`'s `parseAppServices` now delegates to `@agentproto/app-kit`'s `parseServiceList` instead of carrying its own duplicate validator, unifying the two previously-divergent `services:` rule sets. This changes install-time validation behavior: service names must now start with a letter (a digit-leading name like `0abc` is rejected, though consecutive/trailing hyphens are now allowed), unknown object fields on a service entry are now rejected, validation now fails fast on the first bad entry instead of accumulating every entry's errors, and an explicitly-present but empty `services: []` is now rejected instead of being treated as a no-op.
