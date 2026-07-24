---
"@agentproto/adapter-knowledge-corpus": minor
"@agentproto/adapter-knowledge-gbrain-doc": minor
"@agentproto/adapter-knowledge-qdrant": minor
---

Three new knowledge adapter packages implementing `IKnowledgeProvider`:

- **knowledge-corpus**: Composition wrapper over AIP-10 corpus workspace, hydrates hits with provenance + access policy, rejects public writes (goes through privileged `CorpusInternalWriter`).
- **knowledge-gbrain-doc**: Document API backing via gbrain's JSON-RPC `/mcp` endpoint (put_page/search, list_pages/get_page/delete_page), pure `fetch`, no vendor SDK.
- **knowledge-qdrant**: Vector search over Qdrant collection with OpenAI embeddings (text-embedding-3-small, 1536d), optional tenant-scoped payload filtering, pure `fetch`.

Each registers as a provider-kit family under the `@agentproto/adapter-knowledge-*` discovery convention.
