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

## License

MIT — see [LICENSE](./LICENSE).
