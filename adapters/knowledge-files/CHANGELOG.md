# @agentproto/adapter-knowledge-files

## 0.5.0

### Minor Changes

- e56ebfe: Give the files brain an on-disk, incremental search index, and never refuse a search. With `indexPath` set and a runtime whose `node:sqlite` has FTS5 (Node 22.13+, 23.4+, 24+; 22.5 to 22.12 only with `--experimental-sqlite`), `FilesKnowledgeAdapter` keeps its BM25 index in a SQLite FTS5 file run in a worker thread: `ingest()` upserts that document's row and `deleteSource()` empties it instead of invalidating the whole brain, a stat-only scan on open (then at most every `reconcileIntervalMs`, default 5 minutes, in the background) re-indexes only changed files and drops vanished ones, and a query during the first build answers from what is indexed with `partial: true`. The index stores pre-tokenized text from the same tokenizer, and FTS5 candidates are re-scored with the package's own BM25, so rankings match the in-memory engine (exact on the captured parity fixture, 99.7% top-10 overlap on a generated corpus). The file is derived data: deleted or unreadable, it is rebuilt; a schema or tokenizer change rebuilds it. Without FTS5 (Node 20, older 22) the adapter falls back to the in-memory index, which now indexes the most recently modified `maxIndexDocs` files and flags results `partial` above the ceiling instead of throwing `FilesIndexTooLargeError` (kept, deprecated, no longer thrown). `LocalFs` gains `walkStat()`. `KnowledgeQueryResult` gains an optional `partial` flag. Workspace brains put each `files` provider's index at `<brain>/.index/fts-<id>.sqlite` (`"onDiskIndex": false` in `knowledge.json` opts out), the federated provider propagates `partial`, `GET /brain/query` reports `partial` (and `workspacesPartial` in federated mode), and the `maxIndexDocs` config help now describes it as the in-memory fallback's ceiling.

### Patch Changes

- Updated dependencies [e56ebfe]
  - @agentproto/knowledge-engine@0.4.0

## 0.4.0

### Minor Changes

- 30a58b6: Keep the workspace brain's BM25 index lean and log every build. The files engine no longer keeps each doc's text or a per-doc `tf` Map in the resident index: docs keep only id and token count, every doc's (term id, frequency) pairs live in shared packed typed arrays, and a query reads the top-K files back for their snippet and frontmatter (same ids, order, scores, spans, and snippets as before). A build reads files 50 at a time, builds are serialized across the process, and one line is logged per build (docs, bytes read, duration, heapUsed before and after), per refusal, and per query that times out while a cold build keeps going. Above `maxIndexDocs` indexable files (default 100,000; `defaults.reactions.brainIngest.maxIndexDocs`, or a `knowledge.json` files entry's own `maxIndexDocs`) the engine refuses to build and the query fails with `FilesIndexTooLargeError`, which the federated provider now surfaces instead of swallowing. The federated `GET /brain/query` queries brains one at a time. Breaking for direct BM25 users: `Bm25Index` is reshaped (`vocab` + typed arrays, `df` is a `Uint32Array`), `Bm25Doc` has no `text`/`tf`, and `score()` no longer attaches snippets (use `makeSnippet`).
- 30a58b6: Keep the workspace brain's in-process BM25 index lean: docs retain only id and token count, postings live in shared packed typed arrays, and a query reads the top-K files back for their snippet and frontmatter. Builds run one step of 50 files at a time and are serialized across the process, with one log line per build, refusal, and cold-build query timeout. A new `maxIndexDocs` ceiling (default 100,000, configurable via `defaults.reactions.brainIngest.maxIndexDocs` or a `knowledge.json` files entry) refuses to build and surfaces `FilesIndexTooLargeError`, and federated `GET /brain/query` now queries brains one at a time. Breaking for direct BM25 users (pre-1.0 minor channel): `Bm25Index`/`Bm25Doc` are reshaped and `score()` no longer attaches snippets — use `makeSnippet`.

### Patch Changes

- Updated dependencies [b67f58e]
- Updated dependencies [3f90a9d]
- Updated dependencies [e301b84]
- Updated dependencies [e301b84]
  - @agentproto/corpus@1.0.0
  - @agentproto/provider-kit@0.6.0
  - @agentproto/knowledge-engine@0.3.5

## 0.3.5

### Patch Changes

- Updated dependencies [8aa0aeb]
- Updated dependencies [76003b9]
  - @agentproto/corpus@0.9.0
  - @agentproto/provider-kit@0.5.0
  - @agentproto/knowledge-engine@0.3.4

## 0.3.4

### Patch Changes

- @agentproto/corpus@0.8.4

## 0.3.3

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [74f982c]
- Updated dependencies [74f982c]
  - @agentproto/corpus@0.8.3
  - @agentproto/knowledge-engine@0.3.3
  - @agentproto/provider-kit@0.4.7

## 0.3.2

### Patch Changes

- @agentproto/knowledge-engine@0.3.2

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

## 0.2.13

### Patch Changes

- @agentproto/knowledge-engine@0.2.6

## 0.2.12

### Patch Changes

- Updated dependencies [aa5e4bd]
- Updated dependencies [88f2836]
- Updated dependencies [e8fc640]
  - @agentproto/corpus@0.8.2
  - @agentproto/provider-kit@0.4.6
  - @agentproto/knowledge-engine@0.2.5

## 0.2.11

### Patch Changes

- @agentproto/knowledge-engine@0.2.4
- @agentproto/corpus@0.8.1

## 0.2.10

### Patch Changes

- Updated dependencies [f30c959]
  - @agentproto/provider-kit@0.4.5

## 0.2.9

### Patch Changes

- Updated dependencies [c27f0b8]
- Updated dependencies [f94b632]
  - @agentproto/corpus@0.8.0
  - @agentproto/knowledge-engine@0.2.3
  - @agentproto/provider-kit@0.4.4

## 0.2.8

### Patch Changes

- @agentproto/corpus@0.7.3

## 0.2.7

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [2f37e7b]
  - @agentproto/corpus@0.7.2
  - @agentproto/knowledge-engine@0.2.2
  - @agentproto/provider-kit@0.4.3

## 0.2.6

### Patch Changes

- Updated dependencies [f9e21fd]
  - @agentproto/corpus@0.7.1
  - @agentproto/knowledge-engine@0.2.1
  - @agentproto/provider-kit@0.4.2

## 0.2.5

### Patch Changes

- Updated dependencies [4fb28be]
  - @agentproto/corpus@0.7.0

## 0.2.4

### Patch Changes

- Updated dependencies [2ac7025]
- Updated dependencies [dee9bd8]
- Updated dependencies [5864268]
- Updated dependencies [f0c51a7]
- Updated dependencies [b7d9221]
  - @agentproto/corpus@0.6.0
  - @agentproto/knowledge-engine@0.2.1
  - @agentproto/provider-kit@0.4.2

## 0.2.3

### Patch Changes

- @agentproto/corpus@0.5.2

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

- 4c399fa: Add BM25 files adapter for IKnowledgeProvider (standalone + provider-kit family)

### Patch Changes

- Updated dependencies [c4f2908]
- Updated dependencies [8a4fed0]
- Updated dependencies [4c399fa]
- Updated dependencies [f3b54ad]
- Updated dependencies [04aedad]
  - @agentproto/corpus@0.4.0
  - @agentproto/knowledge-engine@0.2.0
  - @agentproto/provider-kit@0.4.0
