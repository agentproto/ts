---
"@agentproto/knowledge-engine": minor
"@agentproto/adapter-knowledge-corpus": minor
"@agentproto/adapter-knowledge-files": minor
"@agentproto/adapter-knowledge-qdrant": minor
"@agentproto/adapter-knowledge-gbrain-doc": minor
"@agentproto/workspace-brain": minor
"@agentproto/runtime": patch
---

`IKnowledgeProvider` gains `supersede(id, by?)` and `explain(id)`, plus the `KnowledgeProvenance` type and a typed `KnowledgeNotSupportedError`. The corpus adapter implements both for real: `supersede` flips an AIP-10 entry to `deprecated` with a `supersededBy` link and a `deprecated` attestation (CAS write, `curate` capability when a caller is set), and `explain` returns the entry's sources and attestation chain, honoring the same visibility rules as reads. gbrain-doc implements `explain` from `get_page`; files returns file-level provenance; supersede (all three) and qdrant's explain throw `KnowledgeNotSupportedError`. `FederatedKnowledgeProvider` fans `supersede` out with `Promise.allSettled`: a backend that throws `KnowledgeNotSupportedError` is skipped while another succeeds, but a genuine failure on any backend is surfaced (a partial-apply error naming the failing backends) so backends never silently diverge; it answers `explain` with the first non-null result. Existing methods are unchanged.

Breaking for out-of-tree implementers: `supersede` and `explain` are required members of `IKnowledgeProvider`, so a custom implementation stops compiling until it adds them (throwing `KnowledgeNotSupportedError` is a valid body). This ships as a minor because `@agentproto/knowledge-engine` is pre-1.0 (0.x, where minor is the breaking-change channel); optional methods were rejected because every caller would then need `provider.supersede?.()` guards and a missing implementation would fail at runtime instead of compile time. (runtime: test stub only.)
