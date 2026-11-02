# @agentproto/adapter-knowledge-files

The pure, zero-runtime **files** backing for the
[`@agentproto/knowledge-engine`](../../packages/knowledge-engine)
`IKnowledgeProvider` contract.

Knowledge retrieval from local workspace files via a **BM25 index**, kept on
disk in SQLite FTS5 when the runtime has it and in process otherwise: no
embeddings, no vector store, no network, no API key. It works the instant a
workspace has files to index, which makes it the natural default
corpus backing where AIP-10 entries already live as markdown: the entries
_are_ the index, with no separate store to keep in sync.

## What's in the box

| Export | Role |
| --- | --- |
| `FilesKnowledgeAdapter` | The `IKnowledgeProvider` implementation. Consumes an injected `FsPort`; knows nothing about `node:fs` or `process.env`. |
| `LocalFs` | A `node:fs`-backed `FsPort` (from `@agentproto/corpus`) so the adapter runs standalone. Paths are workspace-relative and can't escape the root. |
| `createStandaloneFilesAdapter()` | Wires `LocalFs` + the typed env into a ready-to-use adapter. |
| BM25 (`tokenize`, `buildIndex`, `buildIndexYielding`, `Bm25IndexBuilder`, `score`, `makeSnippet`) | The dependency-free ranking core. Confined to this package. |
| provider-kit family (`KNOWLEDGE_FILES_CATALOG`, `makeKnowledgeFilesResolver`, `resolveKnowledgeBackend`) | Registers the `files` backend under the `@agentproto/adapter-knowledge-*` discovery convention. |

## Usage

Standalone, driven by env:

```ts
import { createStandaloneFilesAdapter } from "@agentproto/adapter-knowledge-files"

const kb = createStandaloneFilesAdapter()
const { hits } = await kb.query({ query: "usage based pricing", topK: 5 })
```

With a host-provided `FsPort` (e.g. a studio guild workspace):

```ts
import { FilesKnowledgeAdapter } from "@agentproto/adapter-knowledge-files"

const kb = new FilesKnowledgeAdapter({ fs, workspacePath: "knowledge" })
```

With an on-disk index (recommended for anything large):

```ts
const kb = new FilesKnowledgeAdapter({
  fs,
  workspacePath: "knowledge",
  indexPath: "/abs/path/to/brain/.index/fts.sqlite",
})
```

Through the provider-kit resolver (discovery / catalogs):

```ts
import { makeKnowledgeFilesResolver } from "@agentproto/adapter-knowledge-files"

const handle = await makeKnowledgeFilesResolver()("files")
const provider = handle?.provider()
```

## Environment

Read once through the typed `loadFilesKnowledgeEnv()` — the only place these
names live:

| Var | Default | Meaning |
| --- | --- | --- |
| `KNOWLEDGE_FILES_ROOT` | `process.cwd()` | Absolute host path the `LocalFs` is rooted at. |
| `KNOWLEDGE_FILES_PATH` | `knowledge` | Workspace-relative folder walked and indexed (recursively). |
| `KNOWLEDGE_FILES_INDEX_PATH` | unset | Absolute path of the on-disk index file. Unset: in-memory index. |

## Indexing model

- **Indexed extensions:** `.md`, `.markdown`, `.txt`, `.yaml`, `.yml`, `.json`.
  YAML frontmatter is stripped before tokenizing so schema fences don't pollute
  the vocabulary; frontmatter is still surfaced as each hit's `metadata` (and a
  `slug` mirrors to `entrySlug` for corpus hydration).
- **Ranking:** standard BM25 (k1=1.5, b=0.75) with `+1`-smoothed IDF, on both
  engines (see the on-disk section for how).
- **Two engines.** With `indexPath` set and a runtime whose `node:sqlite` has
  FTS5, the index lives on disk; otherwise (no `indexPath`, Node 20, Node
  22.5-22.12 without `--experimental-sqlite`, or the on-disk index failing to
  open) it lives in process. `node:sqlite` is loaded dynamically, so the
  package still runs on `node >= 20.9`.

### On-disk index (SQLite FTS5)

- **Where:** the file at `indexPath`, e.g. `<brain>/.index/fts.sqlite` (a
  hidden directory, so never walked as content). WAL mode, one connection per
  file per process. It is derived data: delete it and the next open rebuilds
  it; an unreadable file is deleted and rebuilt; a schema or tokenizer change
  (`meta.version`) drops the tables and rebuilds.
- **Off the main thread:** SQLite runs in a `worker_threads` worker
  (`indexWorker: false` runs it inline). The build reads files on the caller's
  thread, 100 per batch, and hands them to the worker, which tokenizes and
  writes them in one transaction per batch.
- **Incremental:** `ingest()` upserts the written doc's row, `deleteSource()`
  empties it. Nothing invalidates the whole brain.
- **External edits:** on open, and then at most every `reconcileIntervalMs`
  (default 5 min, checked when a query arrives, run in the background), a
  stat-only scan (path, size, mtime) re-indexes only the files that changed
  and drops rows whose file is gone. `invalidate()` makes the next query
  start one.
- **First build:** batched and yielding. A query during it answers from what
  is already indexed and sets `partial: true` on the result; it never waits,
  fails, or refuses.
- **Ranking parity:** the FTS column stores the doc's tokens from the same
  tokenizer (lowercase, split on non `[a-z0-9]`, length 2-32, stopwords,
  frontmatter stripped) under FTS5's `ascii` tokenizer, so doc lengths and
  frequencies match the in-memory engine. FTS5's `bm25()` (k1 1.2, and a zero
  IDF for terms in more than half the docs) picks `max(topK * 8, 80)`
  candidates (at most 300); those are re-scored with this package's BM25 from
  their text, read back from disk anyway for the snippet. On a generated
  corpus the top-10 overlap with the in-memory engine is 99.7%; the captured
  parity fixture matches exactly. Only docs matching at least one query term
  are returned, so a negative `minScore` does not pad the result.
- **No ceiling:** `maxIndexDocs` does not apply.

### In-memory index (fallback)

- **Cache:** built lazily on first query and cached permanently, rebuilt only
  when the adapter `invalidate()`s (via `ingest`/`delete`) or a fresh instance
  is created.
- **Memory:** the resident index holds no doc text: per doc only its id and
  token count, plus every doc's (term id, term frequency) pairs packed into
  shared typed arrays and one term vocabulary. A query reads the top-K files
  back from disk for their snippet and frontmatter. A build reads files 50 at a
  time, so only one step of text is alive at once.
- **Ceiling:** above `maxIndexDocs` indexable files (default 100,000) it
  indexes the most recently modified `maxIndexDocs` files and flags every
  result `partial: true`. Search is never refused (`FilesIndexTooLargeError` is
  kept for compatibility but no longer thrown).
- **Cold build:** a query waits at most `queryTimeoutMs` (4 s) for it, then
  answers with no hits and `partial: true` while the build keeps going.

### Both engines

- **One build at a time:** index builds (and on-disk reconciles) are
  serialized across every adapter in the process, so cold queries on several
  brains never stack their peaks.
- **Logs:** one line per build (`[knowledge-files:<label>] index built: N docs,
  B bytes read, T ms, heapUsed X MB -> Y MB`, plus `(on disk, F files scanned
  in S ms)` for the on-disk engine), per on-disk open, per reconcile
  (`index reconciled: F files scanned in S ms, C re-indexed, R removed, B bytes
  read, T ms; U upserts and D deletes applied incrementally since the last
  reconcile`), per query answered from a partial on-disk index, per in-memory
  cap, per fallback to the in-memory engine, and per query that times out
  waiting for a cold in-memory build. Inject `log` to route them elsewhere.

## Provenance and supersession

`explain(id)` returns file-level provenance (the file's `uri` plus its own
frontmatter in `metadata`; `derivedFrom` is empty) or `null` for an unknown id.
`supersede()` throws `KnowledgeNotSupportedError` — plain files carry no
lifecycle status; use the corpus adapter over an AIP-10 workspace.

## Capabilities

`vectorSearch: false`, `hybridSearch: false`, `citations: true` — BM25 returns
ranked hits with a file path + byte span, usable as citations even without a
vector concept.

Apache-2.0.
