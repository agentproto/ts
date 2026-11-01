---
"@agentproto/adapter-knowledge-files": minor
"@agentproto/workspace-brain": minor
"@agentproto/runtime": minor
---

Keep the workspace brain's BM25 index lean and log every build. The files engine no longer keeps each doc's text or a per-doc `tf` Map in the resident index: docs keep only id and token count, every doc's (term id, frequency) pairs live in shared packed typed arrays, and a query reads the top-K files back for their snippet and frontmatter (same ids, order, scores, spans, and snippets as before). A build reads files 50 at a time, builds are serialized across the process, and one line is logged per build (docs, bytes read, duration, heapUsed before and after), per refusal, and per query that times out while a cold build keeps going. Above `maxIndexDocs` indexable files (default 100,000; `defaults.reactions.brainIngest.maxIndexDocs`, or a `knowledge.json` files entry's own `maxIndexDocs`) the engine refuses to build and the query fails with `FilesIndexTooLargeError`, which the federated provider now surfaces instead of swallowing. The federated `GET /brain/query` queries brains one at a time. Breaking for direct BM25 users: `Bm25Index` is reshaped (`vocab` + typed arrays, `df` is a `Uint32Array`), `Bm25Doc` has no `text`/`tf`, and `score()` no longer attaches snippets (use `makeSnippet`).
