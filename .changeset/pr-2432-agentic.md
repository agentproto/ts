---
"@agentproto/adapter-knowledge-files": minor
"@agentproto/workspace-brain": minor
"@agentproto/runtime": minor
---

Keep the workspace brain's in-process BM25 index lean: docs retain only id and token count, postings live in shared packed typed arrays, and a query reads the top-K files back for their snippet and frontmatter. Builds run one step of 50 files at a time and are serialized across the process, with one log line per build, refusal, and cold-build query timeout. A new `maxIndexDocs` ceiling (default 100,000, configurable via `defaults.reactions.brainIngest.maxIndexDocs` or a `knowledge.json` files entry) refuses to build and surfaces `FilesIndexTooLargeError`, and federated `GET /brain/query` now queries brains one at a time. Breaking for direct BM25 users (pre-1.0 minor channel): `Bm25Index`/`Bm25Doc` are reshaped and `score()` no longer attaches snippets — use `makeSnippet`.
