---
"@agentproto/catalog": patch
"@agentproto/corpus": patch
"@agentproto/eval": patch
---

Stop claiming an AIP registry spec name. Each package now exposes an internal format id (`CATALOG_FORMAT`, `CORPUS_FORMAT`, `EVAL_FORMAT`) and keeps its legacy `SPEC_NAME` only for compatibility.
