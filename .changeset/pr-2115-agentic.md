---
"@agentproto/computer-api": patch
"@agentproto/sandbox-computer": patch
---

Docs-only sync of the two READMEs with the already-shipped stable session-holder behavior (#2114): `computer-api` documents the idempotent `holder` re-attach (200 with the session count unchanged), and `sandbox-computer` documents that a re-connect by the same `sessionHolder` is idempotent and keeps its slot. No runtime change.
