---
"@agentproto/pr-outcome": minor
---

New private package `@agentproto/pr-outcome`: an observation-only collector that joins merged-PR outcomes (reviews, bot vs human comments, commits after first review, CI failures, revert detection) with the `@agentproto-bot` provenance footer parsed back via `@agentproto/pr-outcome`'s `parseFooter`. These records are anecdotal — `basis: "observed"`, unobservable fields left `undefined` — and are never an input to routing rules or quotas. The package is `private: true` and does not reach the npm surface.
