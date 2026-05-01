# @agentproto/tool

Reference implementation of
[**AIP-14 TOOL.md**](https://agentik.net/docs/aip-14) `defineTool` contract.

A vendor-neutral tool registration primitive: an author writes a single
`defineTool({...})` module + an optional sidecar `TOOL.md` manifest, and any
framework-specific adapter (`@agentproto/adapter-mastra`, `@agencies/tool-langchain`,
`@agencies/tool-a2a`, …) can wrap the resulting `ToolHandle` into its native
tool API.

```ts
import { defineTool, ToolError } from "@agentproto/tool"
import { z } from "zod"

export default defineTool({
  id: "echo",
  description: "Returns its input verbatim.",
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ echo: z.string() }),
  mutates: [],
  approval: "auto",
  execute: async ({ input }) => {
    if (input.message.length > 10_000) {
      throw new ToolError({
        code: "input_invalid",
        message: "message too long",
      })
    }
    return { echo: input.message }
  },
})
```

The host calls `handle.execute({ input, context })`. The runtime validates
`input` against `inputSchema` (rejects with
`ToolError({ code: "input_invalid" })` on shape mismatch) before invoking the
body, then validates the body's return against `outputSchema`. Errors travel
out-of-band: success returns the value; failures throw a `ToolError` that
adapters MUST wrap into the standard `ToolResult<T>` envelope.

## Spec

See [AIP-14](https://agentik.net/docs/aip-14) for the canonical `defineTool`
contract and conformance rules. This package is the TypeScript reference
implementation.

## Adapter packages

- `@agentproto/adapter-mastra` — `toMastraTool(handle, ctx)` (planned)
- `@agencies/tool-langchain` — (planned)
- `@agencies/tool-a2a` — (planned)
