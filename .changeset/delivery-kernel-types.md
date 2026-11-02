---
"@agentproto/delivery": minor
"@agentproto/sentinel": patch
---

New `@agentproto/delivery` package: the pure core of the delivery kernel (`Envelope`, `Level`, `levelToTier`, `computeLevel`, `createClassifierRegistry`, `RecentKeys`), with no I/O and no producer knowledge. `@agentproto/sentinel` now takes `RecentKeys` from it and re-exports it unchanged.
