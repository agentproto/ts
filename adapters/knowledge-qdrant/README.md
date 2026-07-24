# @agentproto/adapter-knowledge-qdrant

The **vector-search** backing for the
[`@agentproto/knowledge-engine`](../../packages/knowledge-engine)
`IKnowledgeProvider` contract.

Implements the ingest/query contract over a **Qdrant** collection, reached via
pure `fetch` (no vendor SDK), with **OpenAI-compatible embeddings**
(`text-embedding-3-small`, 1536d, by default — routable to Azure / Ollama /
vLLM via `OPENAI_BASE_URL`). An optional **`tenantId`** payload scope isolates
many tenants inside one shared collection.

The vector-search sibling of
[`@agentproto/adapter-knowledge-files`](../knowledge-files) (BM25) and
[`@agentproto/adapter-knowledge-corpus`](../knowledge-corpus) (AIP-10
composition).

> **Tenant scope, not guild scope.** This adapter was lifted from a studio
> provider whose tenant partition key was named `guildId`. That field was
> renamed to a generic **`tenantId`** on the re-home — nothing here imports
> `@agstudio/*` or knows what a guild is; it is a plain multi-tenant partition
> key on the point payload.

## What's in the box

| Export | Role |
| --- | --- |
| `QdrantKnowledgeAdapter` | The `IKnowledgeProvider` implementation. Config-driven — consumes a plain `QdrantAdapterConfig`; knows nothing about `process.env`. |
| `QdrantAdapterConfigSchema` / `parseQdrantAdapterConfig` | The zod config contract (endpoint, collection, embeddings, optional `tenantId`). |
| `translateFilter` | The `CorpusFilter` → Qdrant payload-filter translation (exported for testing). |
| `loadQdrantKnowledgeEnv` / `qdrantEnvToConfig` | The typed env module — the ONE place `QDRANT_*` / `OPENAI_*` are read. |
| `createStandaloneQdrantAdapter()` | Wires the typed env into a ready-to-use adapter. |
| provider-kit family (`KNOWLEDGE_QDRANT_CATALOG`, `makeKnowledgeQdrantResolver`, `resolveKnowledgeBackend`) | Registers the `qdrant` backend under the `@agentproto/adapter-knowledge-*` discovery convention. |

## Environment

| Var | Required | Default | Meaning |
| --- | --- | --- | --- |
| `QDRANT_URL` | ✅ | — | Base URL of the Qdrant instance. |
| `QDRANT_API_KEY` | | — | Sent as the `api-key` header (unsecured local deployments need none). |
| `QDRANT_COLLECTION` | | `knowledge` | Collection to read/write (must exist with the right vector size). |
| `OPENAI_API_KEY` | ✅ | — | Key for the OpenAI-compatible `/embeddings` call. |
| `OPENAI_EMBEDDING_MODEL` | | `text-embedding-3-small` | Embedding model id (1536d). |
| `OPENAI_BASE_URL` | | `https://api.openai.com/v1` | Embeddings base URL (Azure / Ollama / vLLM). |
| `KNOWLEDGE_QDRANT_TENANT_ID` | | — | Tenant scope. When set, ingest tags every point and query/get/delete force a `must tenantId` clause. |

## Usage

```ts
import {
  QdrantKnowledgeAdapter,
  createStandaloneQdrantAdapter,
} from "@agentproto/adapter-knowledge-qdrant"

// From the ambient QDRANT_* / OPENAI_* env:
const kb = createStandaloneQdrantAdapter()

// Or construct directly (e.g. a host resolving a per-KB config + vault secret):
const direct = new QdrantKnowledgeAdapter({
  endpoint: "http://127.0.0.1:6333",
  collection: "knowledge",
  embeddingApiKey: process.env.OPENAI_API_KEY!,
  tenantId: "tenant-42", // optional — isolates this tenant in a shared collection
})

await kb.ingest({ kind: "text", uri: "doc://intro", content: "…" })
const { hits } = await kb.query({ query: "how do I ship", topK: 5 })
```

## Scope

Supported: `ingest({ kind: "text" | "url" })`, `query` (vector), `listSources`,
`getSource`, `deleteSource`, `healthCheck`. Out of scope (throws a clean
error): `kind: "file" | "connector"` ingestion (needs a host-side resolver);
`graph` / `hybrid` query modes (Qdrant is vector-only here — the adapter falls
back to vector and stamps `modeUsed: "vector"`).

## Testing

Unit tests run against a mocked `globalThis.fetch` + a canned embeddings
response — **no live Qdrant and no real embeddings API** (CI-safe). They assert
the request shapes (upsert / search / scroll / delete), the result mapping, and
the `tenantId` payload filter.

```sh
pnpm --filter @agentproto/adapter-knowledge-qdrant test
```

## License

Apache-2.0
