---
"@agentproto/cli": minor
---

`agentproto maintain --max-reviews <n>` caps how many unmerged branches the run sends to a reviewer (newest tip first). It forwards the workflow's existing `maxReviews` input, which the CLI could not set before; without the flag the workflow default (40) still applies. A value that is not a positive integer exits 2 before any daemon contact.
