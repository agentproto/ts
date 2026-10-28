---
"@agentproto/memory": minor
"@agentproto/harness": patch
---

`@agentproto/memory` adds the AIP-72 section 8 store: the `MemoryStore` port (alias `IMemoryStore`), its typed errors (`MemoryConflictError`, `MemoryNotFoundError`, `MemoryTransitionError`, `MemorySlugTakenError`), and `FilesMemoryStore`, a store over the reference layout (`items/<type>/<id>.md`, `proposals/<sha256>.md`) with SHA-256 compare-and-set revisions, status-only supersede and archive, no hard delete, and a keyword search that can merge an AIP-10 knowledge provider's hits. `@agentproto/harness` accepts the AIP-72 `capabilities.memory` projection declaration (`inject`, `capture`) in a harness manifest.
