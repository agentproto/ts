---
"@agentproto/adapter-knowledge-corpus": minor
---

Add legal validity window fields to corpus temporal metadata: `inForceFrom`, `inForceTo`, `abrogated`, `versionedAt`. These fields describe when a norm is legally in force (distinct from `halfLifeDays`, which governs relevance decay). Consumers can now flag not-in-force law without rescoring. All fields are optional and pass through verbatim when declared, omitted entirely when absent.
