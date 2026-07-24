# @agentproto/adapter-knowledge-corpus

The **corpus** composition backing for the
[`@agentproto/knowledge-engine`](../../packages/knowledge-engine)
`IKnowledgeProvider` contract.

Wraps **any** backing `IKnowledgeProvider` (files, qdrant, gbrain, …) over an
[AIP-10](https://agentproto.sh) `@agentproto/corpus` workspace and:

- reads canonical AIP-10 entries + sources directly from the workspace via an
  injected `FsPort`,
- delegates the vector/graph query to the backing engine,
- **hydrates** every hit with canonical provenance — `entryPath`, `sourceIds`,
  `sourceHashes`, `kind`, `title`, `status`, `qualityScore`, `riskScore`,
  `domain`, `channel`, and a live temporal decay score,
- enforces the corpus **access policy** (silently filters hits/sources the
  caller can't see; fails closed on unverifiable provenance),
- **rejects public `ingest()` / `deleteSource()`** — corpus writes go through
  the privileged `CorpusInternalWriter` at the end of the AIP-18 candidate
  lifecycle, never agent-side.

The composition sibling of
[`@agentproto/adapter-knowledge-files`](../knowledge-files).

## What's in the box

| Export | Role |
| --- | --- |
| `CorpusAdapterCore` | The `IKnowledgeProvider` implementation. Consumes an injected `FsPort` + a backing engine; knows nothing about `node:fs` or `process.env`. |
| `CorpusInternalWriter` | The privileged write path (NOT an `IKnowledgeProvider`) — `pushChunks` / `removeEntry` against the backing engine with corpus-namespaced metadata. |
| `buildCorpusIndex`, `hydrateHit`, `computeTemporalScore` | The provenance-hydration + temporal-decay core. Confined to this package. |
| `readCorpusBlock` / `readCorpusFrontmatter` / `readCorpusTemporal` | Typed `metadata.corpus.*` accessors. |
| `isCorpusBackingUnwrap` | Structural guard for reaching the wrapped backing engine without an `instanceof`/engine-id branch. |
| `LocalFs` | A `node:fs`-backed `FsPort` (from `@agentproto/corpus`) so the adapter runs standalone. Paths are workspace-relative and can't escape the root. |
| `createEmptyBacking()` | A no-op in-process backing (zero query hits) for standalone health probes + the workspace-direct read paths. |
| `createStandaloneCorpusAdapter()` | Wires `LocalFs` + the typed env + a (default empty) backing into a ready-to-use adapter. |
| provider-kit family (`KNOWLEDGE_CORPUS_CATALOG`, `makeKnowledgeCorpusResolver`, `resolveKnowledgeBackend`) | Registers the `corpus` backend under the `@agentproto/adapter-knowledge-*` discovery convention. |

## Usage

Wrapping a real backing engine (the common case):

```ts
import { CorpusAdapterCore } from "@agentproto/adapter-knowledge-corpus"

// `backing` is any IKnowledgeProvider — e.g. a FilesKnowledgeAdapter or a
// qdrant adapter. `fs` is a workspace-rooted FsPort.
const kb = new CorpusAdapterCore({ fs, workspacePath: "corpora/marketing", backing })
const { hits } = await kb.query({ query: "contrarian hook", topK: 5 })
// every hit.metadata carries entryPath, sourceIds, status, temporal, …
```

Standalone, driven by env (empty backing unless one is supplied):

```ts
import { createStandaloneCorpusAdapter } from "@agentproto/adapter-knowledge-corpus"

const kb = createStandaloneCorpusAdapter({ backing })
```

Through the provider-kit resolver (discovery / catalogs):

```ts
import { makeKnowledgeCorpusResolver } from "@agentproto/adapter-knowledge-corpus"

const handle = await makeKnowledgeCorpusResolver()("corpus")
const provider = handle?.provider({ backing })
```

## Environment

Read once through the typed `loadCorpusKnowledgeEnv()` — the only place these
names live:

| Var | Default | Meaning |
| --- | --- | --- |
| `KNOWLEDGE_CORPUS_ROOT` | `process.cwd()` | Absolute host path the `LocalFs` is rooted at. |
| `KNOWLEDGE_CORPUS_PATH` | `""` (root is the workspace) | Workspace-relative folder holding `KNOWLEDGE.md` + `entries/` + `sources/`. |

## Writes go through the lifecycle, not `ingest()`

`CorpusAdapterCore.ingest()` and `deleteSource()` **always throw** — this is
the architectural invariant that keeps agent-side code from bypassing the
AIP-18 candidate review pipeline. Chunks land in the backing engine via
`CorpusInternalWriter`, which the host constructs at boot and hands only to the
indexer.

## Capabilities

Derived from the wrapped backing engine, with `citations` forced to `true` (the
adapter always emits `entryPath` + `sourceIds` provenance).

## Relationship to studio

Lifted from the studio `packages/integration/knowledge` corpus provider. The
adapter/hydrate/internal-writer/frontmatter/unwrap logic already carried no
`@guilde`/`@simone`/`@agstudio` edge — it re-homes verbatim (only the
`IKnowledgeProvider` + data-type imports repoint to
`@agentproto/knowledge-engine`). The guild-side `KnowledgeEngineDescriptor`
(recursive registry resolution + Settings-UI fields) is **not** lifted; it
stays studio-side, and this package registers as a provider-kit family instead.

Apache-2.0.
