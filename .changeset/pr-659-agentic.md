---
"@agentproto/corpus": minor
"@agentproto/corpus-cli": minor
---

Add CodeImporter — new corpus importer that transforms source code trees into knowledge sources. Maintains strict notes-only seam: no symbol graphs, call graphs, or cross-source ref edges (deferred per AIP-27). Supports file or module granularity, include globs, symbol extraction, and content-hash deduplication. Includes comprehensive test coverage and safe CLI dry-run mode.
