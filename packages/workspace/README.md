# @agentproto/workspace

AIP-34 `WORKSPACE.md` reference implementation — `workspace/v2`, the canonical and only schema this AIP defines. A markdown + frontmatter format for declaring a workspace node: globally addressable id, `type` (a node kind resolved against the tree's `TYPES.md`, required), owner, storage choice, visibility (`wall`), consent doors (`includes`/`exports`, `apps`/`accepted_apps`) and more. The root manifest of every AIP-organized workspace; pairs with STORAGE.md (AIP-35) for the storage policy block.

Spec: <https://agentproto.sh/docs/aip-34>

## Usage

```ts
import { defineWorkspace } from "@agentproto/workspace"

const x = defineWorkspace({
  schema: "workspace/v2",
  id: "@acme/my-workspace",
  version: "1.0.0",
  name: "My Workspace",
  type: "project", // required — must resolve in the nearest TYPES.md
  owner: { type: "org", id: "acme", slug: "acme" },
  storage: { inline: { provider: "local-fs", config: {} } },
  description: "Short purpose.",
})
```

## Node scope

A session is scoped to the nearest declared node (a folder with a `WORKSPACE.md`) containing its AIP-46 `ground` (AIP-34, "Node scope of a session").

```ts
import { resolveNodeScope, nodeChain, nodeProjection, composeNodeChainPolicy } from "@agentproto/workspace"
import { loadNodeTree } from "@agentproto/workspace/checker"

const tree = loadNodeTree("/path/to/tree")
const scope = resolveNodeScope(tree, "ws://workspaces/@acme/agentik/simone/docs") // { node, subpath: "docs" } or undefined
const chain = nodeChain(tree, scope.node) // nearest first, up to the tree root, each node with its `wall`
const memoryNodes = nodeProjection(chain) // AIP-72 section 10: cut after the first sealed or hard node
const policy = composeNodeChainPolicy(chain) // AIP-38 composition inputs over the whole chain
```

`undefined` means no declared node contains the ground, so no node scope. A malformed ground throws `NodeScopeError`; a host refuses the call.

## License

MIT — see [LICENSE](./LICENSE).
