# @agentproto/adapter-knowledge-corpus

## 0.3.4

### Patch Changes

- Updated dependencies [f9e21fd]
  - @agentproto/corpus@0.7.1
  - @agentproto/knowledge-engine@0.2.1
  - @agentproto/provider-kit@0.4.2

## 0.3.3

### Patch Changes

- Updated dependencies [4fb28be]
  - @agentproto/corpus@0.7.0

## 0.3.2

### Patch Changes

- Updated dependencies [2ac7025]
- Updated dependencies [dee9bd8]
- Updated dependencies [5864268]
- Updated dependencies [f0c51a7]
- Updated dependencies [b7d9221]
  - @agentproto/corpus@0.6.0
  - @agentproto/knowledge-engine@0.2.1
  - @agentproto/provider-kit@0.4.2

## 0.3.1

### Patch Changes

- @agentproto/corpus@0.5.2

## 0.3.0

### Minor Changes

- 54027de: Add legal validity window fields to corpus temporal metadata: `inForceFrom`, `inForceTo`, `abrogated`, `versionedAt`. These fields describe when a norm is legally in force (distinct from `halfLifeDays`, which governs relevance decay). Consumers can now flag not-in-force law without rescoring. All fields are optional and pass through verbatim when declared, omitted entirely when absent.

## 0.2.2

### Patch Changes

- @agentproto/corpus@0.5.1

## 0.2.1

### Patch Changes

- Updated dependencies [c1399f3]
- Updated dependencies [bdba3a5]
  - @agentproto/provider-kit@0.4.1
  - @agentproto/corpus@0.5.0

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
