---
"@agentproto/catalog": minor
"@agentproto/corpus": minor
"@agentproto/eval": minor
---

Add an internal data-format id (`CATALOG_FORMAT`, `CORPUS_FORMAT`, `EVAL_FORMAT`), removing the packages' claims to be AIP registry specs. The legacy `SPEC_NAME` export is retained for compatibility and is now deprecated; it remains a legitimate pending registry-name deviation until it is removed.
