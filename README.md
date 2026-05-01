# agentproto/ts

TypeScript reference implementations of the [agentproto](https://agentproto.sh)
open standards. Companion to [agentproto/agentproto](https://github.com/agentproto/agentproto)
(specifications) and [agentproto/site](https://github.com/agentproto/site)
(docs renderer).

> **Status: 0.1.0-alpha.** APIs are stabilising; expect minor breaking
> changes between alpha releases.

## Packages

```
packages/
├── tool/                          @agentproto/tool         AIP-14 — defineTool, ToolHandle, validators
├── tooling/                       @agentproto/tooling      Internal: shared TS + tsup config
└── driver/
    ├── core/                      @agentproto/driver       AIP-30 — defineDriver, runTool, implementTool, resolver
    ├── cli/                       @agentproto/driver-cli   AIP-29 — CLI/subprocess specialisation
    ├── http/                      @agentproto/driver-http  HTTP API specialisation
    ├── mcp/                       @agentproto/driver-mcp   MCP server specialisation
    └── sdk/                       @agentproto/driver-sdk   SDK / dynamic-import specialisation

adapters/
├── mastra/                        @agentproto/adapter-mastra  Mastra createTool projection
└── ai-sdk/                        @agentproto/adapter-ai-sdk  Vercel AI SDK Tool projection
```

The two-axis design:

- **Drivers** (`packages/driver/<kind>/`) implement TOOL contracts via
  a transport (cli, http, mcp, sdk, builtin). Each is a sibling under
  `driver/`.
- **Adapters** (`adapters/<framework>/`) re-express ToolImplementations
  in a host framework's tool shape. Each is a sibling under `adapters/`.

## Three-layer model

```
ITool         @agentproto/tool         defineTool(...)              the contract (no body)
Tool          @agentproto/driver       implementTool(handle, body)  contract + typed body
Driver        @agentproto/driver       defineDriver({...})          bundle of tools + shared infra
```

Same shape as `IERC20` ↔ `MyToken is IERC20`, ported to TypeScript.

## Getting started

```bash
pnpm install
pnpm -r build
pnpm -r test
```

Author a tool:

```ts
import { defineTool } from "@agentproto/tool"
import { implementTool, defineDriver } from "@agentproto/driver"
import { z } from "zod"

const greetTool = defineTool({
  id: "greet",
  description: "Greets a name in the bound locale.",
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.object({ greeting: z.string() }),
  contextSchema: z.object({ locale: z.enum(["en", "fr"]) }),
})

const greetBuiltin = implementTool(greetTool, async ({ input, context }) => ({
  greeting:
    context.locale === "fr" ? `Bonjour ${input.name}` : `Hello ${input.name}`,
}))

const greetDriver = defineDriver({
  id: "greet-builtin",
  name: "Greet (builtin)",
  description: "In-process greeter.",
  kind: "builtin",
  implements: [{ tool: "greet", version: "0.1.0" }],
  implementations: [greetBuiltin],
})
```

Drop the same implementation into AI SDK or Mastra:

```ts
import { toAiSdkTool } from "@agentproto/adapter-ai-sdk"
import { toMastraTool } from "@agentproto/adapter-mastra"

const aiSdkTool = toAiSdkTool(greetBuiltin, { context: { locale: "en" } })
const mastraTool = toMastraTool(greetBuiltin, {
  source: { context: { locale: "en" } },
})
```

## Specifications

The AIP markdown specs live in [agentproto/agentproto](https://github.com/agentproto/agentproto).
Browse rendered versions at <https://agentproto.sh/docs>.

Key specs implemented here:

- [AIP-14 — TOOL.md](https://agentproto.sh/docs/aip-14)
- [AIP-30 — DRIVER.md](https://agentproto.sh/docs/aip-30)
- [AIP-29 — CLI.md](https://agentproto.sh/docs/aip-29)
- [AIP-17 — RUNNER.md](https://agentproto.sh/docs/aip-17)

## License

MIT — see [LICENSE](./LICENSE).

## Contributing

Spec evolution happens at [agentproto/agentproto](https://github.com/agentproto/agentproto).
This repo tracks AIP progression — implementations follow as AIPs reach
Review/Final status. PRs welcome for runtime bugfixes, perf, and adapter
coverage.
