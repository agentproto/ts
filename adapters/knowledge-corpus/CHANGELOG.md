# @agentproto/adapter-knowledge-corpus

## 0.2.0

### Minor Changes

- e94885e: Lift the studio corpus-backed knowledge provider into a standalone adapter package. CorpusAdapterCore wraps any backing IKnowledgeProvider over an AIP-10 @agentproto/corpus workspace, hydrates every hit with canonical provenance + temporal decay score, enforces access policy, and rejects public ingest/delete (writes route through the privileged CorpusInternalWriter). Ships LocalFs node:fs FsPort + standalone factory + provider-kit family registration.
- a7a0b1f: knowledge qdrant adapter (pr4) stacked on the corpus adapter (pr3) — cumulative delta vs main until pr3 merges

### Patch Changes

- Updated dependencies [c4f2908]
- Updated dependencies [8a4fed0]
- Updated dependencies [4c399fa]
- Updated dependencies [f3b54ad]
- Updated dependencies [04aedad]
  - @agentproto/corpus@0.4.0
  - @agentproto/knowledge-engine@0.2.0
  - @agentproto/provider-kit@0.4.0
