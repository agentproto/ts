---
"@agentproto/runtime": minor
---

Mint a unique human `slug` on every session: `spawnAgent`/`spawnPty` derive one via the shared `mintSlug` (slugified `title || label || adapterSlug || kind`, de-duplicated with `-2`, `-3`, … against held sessions), restored legacy rows are lazily backfilled idempotently on boot, and `renameSession` accepts an optional `slug` override that stays unique instead of throwing. The deprecated `name` becomes a read-only alias resolved through the new `getSlug` (`slug ?? name`); `spawnPty` no longer throws on a colliding `name` and no longer writes `name` at all.
