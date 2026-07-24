# @agentproto/knowledge-engine

Pure, backend-agnostic **knowledge (retrieval) contract** plus the AIP-14
`kb_query` / `kb_ingest` tools, their AIP-30 builtin provider, and thin
AIP-29/31/32 surface projections. The retrieval sibling of
[`@agentproto/code-brain`](../code-brain).

This package names **no** concrete retrieval engine (vector store, graph db,
BM25). A backend implements the `IKnowledgeProvider` contract in a separate
adapter and is injected via the tool context — which is what lets `kb_query`
and `kb_ingest` be authored, typed, and tested against a fake provider
*before* any real backend exists.

The contract + data types are **lifted verbatim** from the studio integration
package (`packages/integration/knowledge/src/providers/base-knowledge.provider.ts`
and `.../types/knowledge.types.ts`), which were already vendor-neutral with
zero cross-app imports; the only change is the import path to fit the new
package boundary.

## The contract — `IKnowledgeProvider`

```ts
interface IKnowledgeProvider {
  readonly id: string
  readonly capabilities: KnowledgeCapabilities
  ingest(input: KnowledgeIngestInput): Promise<KnowledgeSource>
  query(q: KnowledgeQuery): Promise<KnowledgeQueryResult>
  listSources(filter?: ListSourcesFilter): Promise<readonly KnowledgeSource[]>
  getSource(id: string): Promise<KnowledgeSource | null>
  deleteSource(id: string): Promise<void>
  healthCheck(): Promise<boolean>
  dispose(): Promise<void>
}
```

It is deliberately idiom-free: no backend's query dialect appears in these
types. `KnowledgeQuery.mode` (`vector | graph | hybrid | none`) is a *hint* —
an engine that can't serve the requested mode falls back and echoes the mode
it actually used in `KnowledgeQueryResult.modeUsed`. `"none"` is the
cold-start sentinel (no recall this turn). Data types: `KnowledgeCapabilities`,
`KnowledgeSource`, `KnowledgeIngestInput`, `KnowledgeQuery`, `KnowledgeHit`,
`KnowledgeQueryResult`, `ListSourcesFilter`, `CorpusFilter`.

## The tools — `kb_query` / `kb_ingest`

`defineTool → implementTool → defineDriver`, mirroring `@agentproto/code-brain`.
The backend is injected via `contextSchema.knowledgeEngine`; each body
dispatches to one contract method:

| tool | contract method | output | mutation |
|---|---|---|---|
| `kb_query` | `query(...)` | `hits`, `tookMs`, `engine`, `modeUsed` + rendered `answer` | none — `mutates: []`, `idempotent: true`, `riskLevel: 0` |
| `kb_ingest` | `ingest(...)` | `source` + rendered `answer` | `mutates: ["knowledge_source"]`, `idempotent: false`, `riskLevel: 1` |

## Exports

| Subpath | What |
|---|---|
| `.` | contract + data types + zod schemas + both tools + `knowledgeEngineProvider` |
| `./types` | the pure data types + zod mirrors |
| `./tools` | `kbQueryTool`, `kbIngestTool` |
| `./provider` | `knowledgeEngineProvider` (builtin) + `kbQueryBuiltin` + `kbIngestBuiltin` |
| `./mcp` | `defineKnowledgeEngineMcpDriver` — AIP-32 projection |
| `./http` | `defineKnowledgeEngineHttpDriver` — AIP-31 projection |
| `./cli` | `defineKnowledgeEngineCliDriver` — AIP-29 projection |

The projections are wiring only — a later adapter supplies the transport
config (MCP server, HTTP base URL, CLI binary). Nothing connects at import
time and no backend ships in this package.
