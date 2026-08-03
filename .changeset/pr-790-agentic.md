---
"@agentproto/corpus": minor
"@agentproto/corpus-cli": minor
---

Add PDF fetcher: browser-free extraction with `unpdf` as tier-3 in the import-web fetcher chain. Preserves page breaks, extracts document metadata (page count, sha256, title/author/dates), and fails loudly on encryption/missing text layer. Type-safe integration with backward-compatible additions to `FetchedSource` interface.
