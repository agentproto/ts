---
"@agentproto/memory": minor
"@agentproto/runtime": minor
---

`@agentproto/memory` implements AIP-72 section 10 (node scope). The anchor vocabulary gains `node:<id>` (visibility) and `operator:<id>` (ownership). `MemoryScope` (`{nodes, tree?, operator?}`, the precomputed node projection, nearest node first and already cut at a sealed or hard wall) is accepted by `MemoryFilter`, `read`, `write`, `supersede`, `archive` and `dismiss`. `FilesMemoryStore` applies the projection on every operation, so an item outside it reads as not found and a scoped `search` filters before ranking, snippets and the limit. A scoped write gets the session's node and operator anchors by default, `owner: "node"` leaves the operator off, a node anchor must be in the projection, an operator anchor must be the session's, and promotion is a re-tag of the node anchor only. With `declaresTrees: true` a host write with no node anchor is refused. The pure helpers (`isInNodeProjection`, `applyWriteScope`, `assertRetagOnly`, `nodeTag`, `operatorTag`) are exported.

`@agentproto/runtime`: `selectMemoryItems`, `buildMemoryDigest` and `buildNativeMemoryProjection` take an optional `scope` and `operatorGrants`. The node projection is applied before ordering and the size bound, and the digest order now ranks the operator anchor between PR and agent and node anchors between project and global.
