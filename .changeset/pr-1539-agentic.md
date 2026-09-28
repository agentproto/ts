---
"@agentproto/runtime": patch
---

Cache parsed review-ledger entries keyed by `stat` (mtimeMs + size) so repeated `session_tree` polling no longer re-reads and re-parses unchanged attestation files. Own writes invalidate the cached path immediately, reads always guard against writes from other `ReviewLedger` instances over the same root, and annotations (`getAnnotations`) are deliberately excluded from the cache so `pr`/`prState` are never served stale. Also adds a `bench:review-ledger` script for steady-state before/after numbers.
