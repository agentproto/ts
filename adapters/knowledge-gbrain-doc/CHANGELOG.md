# @agentproto/adapter-knowledge-gbrain-doc

## 0.3.1

### Patch Changes

- e927cb2: Docs: document tunnel private-by-default and revoke, knowledge supersede/explain, pricing tiers, and compaction checkpoint/compactRequiresOperator.
- Updated dependencies [dbf571c]
- Updated dependencies [e927cb2]
  - @agentproto/knowledge-engine@0.3.1

## 0.3.0

### Minor Changes

- badf321: `IKnowledgeProvider` gains `supersede(id, by?)` and `explain(id)`, plus the `KnowledgeProvenance` type and a typed `KnowledgeNotSupportedError`. The corpus adapter implements both for real: `supersede` flips an AIP-10 entry to `deprecated` with a `supersededBy` link and a `deprecated` attestation (CAS write, `curate` capability when a caller is set), and `explain` returns the entry's sources and attestation chain, honoring the same visibility rules as reads. gbrain-doc implements `explain` from `get_page`; files returns file-level provenance; supersede (all three) and qdrant's explain throw `KnowledgeNotSupportedError`. `FederatedKnowledgeProvider` fans `supersede` out with `Promise.allSettled`: a backend that throws `KnowledgeNotSupportedError` is skipped while another succeeds, but a genuine failure on any backend is surfaced (a partial-apply error naming the failing backends) so backends never silently diverge; it answers `explain` with the first non-null result. Existing methods are unchanged.

  Breaking for out-of-tree implementers: `supersede` and `explain` are required members of `IKnowledgeProvider`, so a custom implementation stops compiling until it adds them (throwing `KnowledgeNotSupportedError` is a valid body). This ships as a minor because `@agentproto/knowledge-engine` is pre-1.0 (0.x, where minor is the breaking-change channel); optional methods were rejected because every caller would then need `provider.supersede?.()` guards and a missing implementation would fail at runtime instead of compile time. (runtime: test stub only.)

- badf321: Add `supersede()` and `explain()` to the knowledge provider contract, with `KnowledgeNotSupportedError` and provenance types. Implemented across the corpus, files, gbrain-doc, qdrant and federated providers.

### Patch Changes

- Updated dependencies [badf321]
- Updated dependencies [badf321]
  - @agentproto/knowledge-engine@0.3.0

## 0.2.8

### Patch Changes

- @agentproto/knowledge-engine@0.2.6

## 0.2.7

### Patch Changes

- Updated dependencies [88f2836]
  - @agentproto/provider-kit@0.4.6
  - @agentproto/knowledge-engine@0.2.5

## 0.2.6

### Patch Changes

- @agentproto/knowledge-engine@0.2.4

## 0.2.5

### Patch Changes

- Updated dependencies [f30c959]
  - @agentproto/provider-kit@0.4.5

## 0.2.4

### Patch Changes

- c27f0b8: Weekly minor/patch dependency bumps across workspaces (zod, @mastra/*, react, yaml, claude-agent-sdk, etc.).
- Updated dependencies [c27f0b8]
  - @agentproto/knowledge-engine@0.2.3
  - @agentproto/provider-kit@0.4.4

## 0.2.3

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [2f37e7b]
  - @agentproto/knowledge-engine@0.2.2
  - @agentproto/provider-kit@0.4.3

## 0.2.2

### Patch Changes

- f0c51a7: Weekly dependency bump: update 9 minor/patch dependencies to latest versions.
  - @anthropic-ai/claude-agent-sdk 0.3.241 → 0.3.251
  - @ast-grep/napi 0.45.2 → 0.45.3
  - @earendil-works/pi-tui 0.84.2 → 0.84.4
  - @tanstack/react-query 5.102.2 → 5.102.8
  - @testing-library/react 16.3.2 → 16.3.3
  - e2b 2.45.0 → 2.46.1
  - tsx 4.23.12 → 4.23.13
  - turbo 2.10.11 → 2.10.12
  - zod 4.4.3 → 4.5.4

  No code changes; pnpm-lock.yaml updated to reflect new dependency versions.

- Updated dependencies [f0c51a7]
  - @agentproto/knowledge-engine@0.2.1
  - @agentproto/provider-kit@0.4.2

## 0.2.1

### Patch Changes

- Updated dependencies [c1399f3]
  - @agentproto/provider-kit@0.4.1

## 0.2.0

### Minor Changes

- 8e16e61: knowledge gbrain-doc adapter — IKnowledgeProvider over gbrain document API (put_page/search via JSON-RPC /mcp endpoint), pure fetch, no vendor SDK

### Patch Changes

- Updated dependencies [4c399fa]
- Updated dependencies [f3b54ad]
  - @agentproto/knowledge-engine@0.2.0
  - @agentproto/provider-kit@0.4.0
