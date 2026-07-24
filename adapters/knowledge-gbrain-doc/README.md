# @agentproto/adapter-knowledge-gbrain-doc

The **document-retrieval** backing for the
[`@agentproto/knowledge-engine`](../../packages/knowledge-engine)
`IKnowledgeProvider` contract.

Implements the ingest/query contract over a **gbrain** server's document API —
`put_page` (ingest) + `search` (query) — reached over its JSON-RPC `/mcp`
endpoint via pure `fetch` (no vendor SDK). gbrain fuses **lexical (tsvector) +
semantic** recall, so a query stamps `modeUsed: "hybrid"`.

The document-retrieval sibling of
[`@agentproto/adapter-knowledge-files`](../knowledge-files) (BM25),
[`@agentproto/adapter-knowledge-corpus`](../knowledge-corpus) (AIP-10
composition), and
[`@agentproto/adapter-knowledge-qdrant`](../knowledge-qdrant) (vector).

> **Distinct from the code-graph gbrain adapter.**
> [`@agentproto/adapter-code-brain-gbrain`](../code-brain-gbrain) is the
> **code-graph** gbrain adapter (`ICodeBrainProvider`: define / callers /
> callees). **This** package is the **knowledge-document** one
> (`IKnowledgeProvider` over gbrain's document store). Same backend, different
> contract — they never share a package edge; gbrain is reached only at runtime
> over HTTP.

> **No studio edge.** Lifted from a studio provider whose only cross-package
> import was a type-only import of `JsonRpcRequest` / `JsonRpcResponse` from the
> studio `core/protocol` package. That edge is replaced by two inline JSON-RPC
> interfaces — no studio dependency survives.

## What's in the box

| Export | Role |
| --- | --- |
| `GbrainDocKnowledgeAdapter` | The `IKnowledgeProvider` implementation. Config-driven — consumes a plain `GbrainDocAdapterConfig`; knows nothing about `process.env`. |
| `GbrainDocAdapterConfigSchema` / `parseGbrainDocAdapterConfig` | The zod config contract (endpoint, bearer token, timeout). |
| `extractJsonRpcPayload` | Pulls the JSON-RPC envelope out of a gbrain Streamable-HTTP (SSE) response body (exported for testing). |
| `loadGbrainDocKnowledgeEnv` / `gbrainDocEnvToConfig` | The typed env module — the ONE place `GBRAIN_*` is read. |
| `createStandaloneGbrainDocAdapter()` | Wires the typed env into a ready-to-use adapter. |
| provider-kit family (`KNOWLEDGE_GBRAIN_DOC_CATALOG`, `makeKnowledgeGbrainDocResolver`, `resolveKnowledgeBackend`) | Registers the `gbrain-doc` backend under the `@agentproto/adapter-knowledge-*` discovery convention. |

## Environment

| Var | Required | Default | Meaning |
| --- | --- | --- | --- |
| `GBRAIN_BEARER_TOKEN` | ✅ | — | Machine bearer token accepted by the gbrain `/mcp` endpoint (OAuth 2.1 client_credentials). Shared with the code-graph gbrain adapter's HTTP backend by design. |
| `GBRAIN_ENDPOINT` | | `http://127.0.0.1:3132` | gbrain HTTP base URL (the `/mcp` endpoint is appended). |
| `GBRAIN_HTTP_TIMEOUT_MS` | | `45000` | Per-request timeout (ms). |

## Usage

```ts
import {
  GbrainDocKnowledgeAdapter,
  createStandaloneGbrainDocAdapter,
} from "@agentproto/adapter-knowledge-gbrain-doc"

// From the ambient GBRAIN_* env:
const kb = createStandaloneGbrainDocAdapter()

// Or construct directly (e.g. a host resolving a per-KB config + vault secret):
const direct = new GbrainDocKnowledgeAdapter({
  endpoint: "http://127.0.0.1:3132",
  bearerToken: process.env.GBRAIN_BEARER_TOKEN!,
})

await kb.ingest({ kind: "text", uri: "doc://intro", title: "Intro", content: "…" })
const { hits } = await kb.query({ query: "how do I ship", topK: 5 })
```

## Scope

Supported: `ingest` (`put_page` a markdown doc), `query` (`search` — stamps
`modeUsed: "hybrid"`; `minScore` is applied client-side since gbrain `search`
has no server-side score floor), `listSources` / `getSource` / `deleteSource`
(via `list_pages` / `get_page` / `delete_page`), `healthCheck` (`GET /health`).

## Testing

Unit tests run against a mocked `globalThis.fetch` returning canned gbrain
Streamable-HTTP (SSE) frames — **no live gbrain** (CI-safe). They assert the
`put_page` / `search` request shapes and the result mapping into
`KnowledgeSource` / `KnowledgeHit`. A guarded live e2e (`put_page` → `search`
against a running gbrain) runs only when the container is reachable, mirroring
the code-brain gbrain adapter's guarded e2e.

```sh
pnpm --filter @agentproto/adapter-knowledge-gbrain-doc test
```

## License

Apache-2.0
