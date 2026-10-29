---
"@agentproto/memory": minor
"@agentproto/runtime": minor
---

AIP-72 section 10 (node scope): `MemoryScope` (`{nodes, tree?, operator?}`) is accepted by `MemoryFilter`, `read`, `write`, `supersede`, `archive` and `dismiss`; `FilesMemoryStore` applies the node projection on every operation (outside it reads as not found, scoped `search` filters before ranking/snippets/limit), scoped writes default the session's `node:` and `operator:` anchors, `owner: "node"` omits the operator anchor, and promotion is a re-tag of the node anchor only. The pure helpers (`isInNodeProjection`, `applyWriteScope`, `assertRetagOnly`, `nodeTag`, `operatorTag`) are exported.

`@agentproto/runtime`: `selectMemoryItems`, `buildMemoryDigest` and `buildNativeMemoryProjection` accept an optional `scope` and `operatorGrants`; the node projection is applied before ordering and the size bound, and the section 9 order now ranks the operator anchor between PR and agent and node anchors between project and global.
