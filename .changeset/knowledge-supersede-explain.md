---
"@agentproto/knowledge-engine": minor
"@agentproto/adapter-knowledge-corpus": minor
"@agentproto/adapter-knowledge-files": minor
"@agentproto/adapter-knowledge-qdrant": minor
"@agentproto/adapter-knowledge-gbrain-doc": minor
"@agentproto/workspace-brain": minor
---

`IKnowledgeProvider` gains `supersede(id, by?)` and `explain(id)`, plus the `KnowledgeProvenance` type and a typed `KnowledgeNotSupportedError`. The corpus adapter implements both for real: `supersede` flips an AIP-10 entry to `deprecated` with a `supersededBy` link and a `deprecated` attestation (CAS write, `curate` capability when a caller is set), and `explain` returns the entry's sources and attestation chain, honoring the same visibility rules as reads. gbrain-doc implements `explain` from `get_page`; files returns file-level provenance; supersede (all three) and qdrant's explain throw `KnowledgeNotSupportedError`. `FederatedKnowledgeProvider` fans `supersede` out with `Promise.allSettled` and answers `explain` with the first non-null result. Existing methods are unchanged; custom `IKnowledgeProvider` implementations must add the two new methods.
