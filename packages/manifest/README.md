# @agentproto/manifest

Generic verbs for AIP doctypes. See [AIP-1](https://agentproto.sh/docs/aip-1).

```ts
import { createVerbs } from "@agentproto/manifest"

const verbs = createVerbs({
  name: "tool",
  aip: 14,
  schemaLiteral: "agentproto/tool/v1",
  pathOf: (h) => `${h.id}/TOOL.md`,
  define: defineTool,
  parse: parseToolManifest,
})

await verbs.create({ id: "echo", ... }, { dir: "tools" })
const echo = await verbs.load("tools/echo/TOOL.md")
const all = await verbs.list("tools")
await verbs.update("tools/echo/TOOL.md", (p) => ({ ...p, version: "1.0.1" }))
const resolved = await verbs.resolve({ ref: "@agentik/runners/python" }, ctx)
await verbs.delete("tools/echo/TOOL.md")
```

## License
MIT
