# @agentproto/adapter-mastra

Generic Mastra adapter for [AIP-14](https://agentik.net/docs/aip-14)
`ToolHandle`s. Wraps any tool authored via
[`@agentproto/tool`](../tool-runtime) into a Mastra `createTool({...})`
handle.

```ts
import { defineTool } from "@agentproto/tool"
import { toMastraTool } from "@agentproto/adapter-mastra"
import { z } from "zod"

const echo = defineTool({
  id: "echo",
  description: "Returns its input.",
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ echo: z.string() }),
  execute: ({ input }) => ({ echo: input.message }),
})

const mastraEcho = toMastraTool(echo, {
  // Optional: static context fields merged into every invocation.
  contextProvider: () => ({ governanceConfig: getGovernanceConfig() }),
})
```

`toMastraTool` produces a Mastra-native handle whose `execute` calls
`handle.invoke(...)` from the runtime — so input/output validation,
schema-defined errors, and AIP-14 conformance happen once, regardless of which
framework consumes the tool.

## Mapping

| AIP-14 ToolHandle                  | Mastra createTool                                        |
| ---------------------------------- | -------------------------------------------------------- |
| `id`                               | `id`                                                     |
| `description`                      | `description`                                            |
| `inputSchema` (zod)                | `inputSchema`                                            |
| `outputSchema` (zod)               | `outputSchema`                                           |
| `invoke({input, context})`         | `execute(inputData, mastraContext) → handle.invoke(...)` |
| `mutates`, `approval`, `riskLevel` | `metadata` (Mastra has no first-class fields for these)  |

## Spec

See [AIP-14](https://agentik.net/docs/aip-14).
