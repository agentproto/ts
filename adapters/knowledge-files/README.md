# @agentproto/adapter-knowledge-files

The pure, zero-runtime **files** backing for the
[`@agentproto/knowledge-engine`](../../packages/knowledge-engine)
`IKnowledgeProvider` contract.

Knowledge retrieval from local workspace files via an **in-process BM25
index** — no embeddings, no vector store, no network, no API key. It works the
instant a workspace has files to index, which makes it the natural default
corpus backing where AIP-10 entries already live as markdown: the entries
_are_ the index, with no separate store to keep in sync.

## What's in the box

| Export | Role |
| --- | --- |
| `FilesKnowledgeAdapter` | The `IKnowledgeProvider` implementation. Consumes an injected `FsPort`; knows nothing about `node:fs` or `process.env`. |
| `LocalFs` | A `node:fs`-backed `FsPort` (from `@agentproto/corpus`) so the adapter runs standalone. Paths are workspace-relative and can't escape the root. |
| `createStandaloneFilesAdapter()` | Wires `LocalFs` + the typed env into a ready-to-use adapter. |
| BM25 (`tokenize`, `buildIndex`, `buildIndexYielding`, `score`) | The dependency-free ranking core. Confined to this package. |
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

## Indexing model

- **Indexed extensions:** `.md`, `.markdown`, `.txt`, `.yaml`, `.yml`, `.json`.
  YAML frontmatter is stripped before tokenizing so schema fences don't pollute
  the vocabulary; frontmatter is still surfaced as each hit's `metadata` (and a
  `slug` mirrors to `entrySlug` for corpus hydration).
- **Ranking:** standard BM25 (k1=1.5, b=0.75) with `+1`-smoothed IDF.
- **Cache:** the index is built lazily on first query and cached permanently —
  it's rebuilt only when the adapter `invalidate()`s (via `ingest`/`delete`) or
  a fresh instance is created. Hosts wanting second-precision freshness on
  external edits can wire fs-watch into a new instance.

## Capabilities

`vectorSearch: false`, `hybridSearch: false`, `citations: true` — BM25 returns
ranked hits with a file path + byte span, usable as citations even without a
vector concept.

Apache-2.0.
