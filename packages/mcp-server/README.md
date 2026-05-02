# @agentproto/mcp-server

MCP server exposing every AIP doctype as tools. Built on `@agentproto/manifest`.

## Usage

```ts
import { runStdioServer } from "@agentproto/mcp-server"
import { toolSpec } from "@agentproto/tool"
import { driverSpec } from "@agentproto/driver"
// …

await runStdioServer({
  specs: [toolSpec, driverSpec, /* … */],
  workspace: process.cwd(),  // auto-loads workspace/extensions/*/EXTENSION.md
})
```

Registers per spec:
  - `create_<name>` — author a manifest from params
  - `load_<name>` — read a manifest
  - `list_<name>` — walk a tree
  - `update_<name>` — patch
  - `resolve_<name>` — inline | ref | file dispatch
  - `delete_<name>` — remove

## License
MIT
