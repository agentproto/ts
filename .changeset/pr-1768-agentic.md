---
"@agentproto/knowledge-engine": minor
"@agentproto/adapter-knowledge-corpus": minor
"@agentproto/adapter-knowledge-files": minor
"@agentproto/adapter-knowledge-gbrain-doc": minor
"@agentproto/adapter-knowledge-qdrant": minor
"@agentproto/workspace-brain": minor
"@agentproto/runtime": patch
---

Add `supersede()` and `explain()` to the knowledge provider contract, with `KnowledgeNotSupportedError` and provenance types. Implemented across the corpus, files, gbrain-doc, qdrant and federated providers.
