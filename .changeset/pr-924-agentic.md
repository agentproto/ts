---
"@agentproto/workspace-brain": minor
"@agentproto/runtime": patch
---

Multi-provider knowledge federation: introduce `FederatedKnowledgeProvider` for concurrent query/ingest across multiple knowledge backends (files, gbrain-doc, qdrant) with min-max score normalization, per-provider weighting, and graceful degradation. Add `provider-resolver.ts` for config-driven adapter instantiation with environment secret resolution and schema validation. Integrate per-workspace `knowledge.json` config loading in workspace-brains with resilient fallback to default single-provider (files) behavior.
