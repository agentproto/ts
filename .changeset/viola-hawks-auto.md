---
"@agentproto/runtime": patch
---

Route session lookup through a single id/slug/legacy-name resolver

`findByIdOrName` now delegates to the shared resolver: a query is trimmed, exact `slug` matches are honored, and a query matching more than one session (duplicate legacy `name`s) resolves to not-found instead of the previous silent first match. A multi-key `SessionRef` whose keys disagree now returns the new `{ code: "conflict", query, keys }` error instead of `not_found`. The returned type is unchanged.
