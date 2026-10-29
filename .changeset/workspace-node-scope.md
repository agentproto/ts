---
"@agentproto/workspace": minor
---

Add AIP-34 node-scope helpers: `resolveNodeScope` (nearest declared node containing a session's ground, with subpath), `nodeChain` and `nodeProjection` (chain to the tree root with walls, cut after the first sealed or hard node), `composeNodeChainPolicy`, and `loadNodeTree` / `canonicalizeGround` on `./checker`. Add `validateTypesRegistry` for TYPES.md `extends` cycles and undeclared parents (also reported by `checkWorkspaceTree`), and stop `resolveTypeEntry` from overflowing the stack on a cycle.
