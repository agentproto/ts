# @agentproto/sdk

The umbrella entry point for [`agentproto/ts`](../../README.md).

One package re-exports the authoring primitives spread across the monorepo -
AIP-14 **tools**, AIP-30 **drivers**, AIP-42 **agents** - and adds a small
`createAgent` glue layer, so a first agent is a handful of lines instead of
five imports.

```ts
import { createAgent, defineTool } from "@agentproto/sdk"
import { z } from "zod"

const weather = defineTool({
  id: "weather",
  description: "Get weather",
  inputSchema: z.object({ city: z.string() }),
})

const agent = createAgent({
  id: "greeter",
  model: "anthropic/claude-sonnet-5",
  tools: [weather],
})

console.log(await agent.run("Weather in Paris?"))
```

`defineTool` returns a **contract** (AIP-14): schemas + governance metadata,
no body. To make a tool callable, bind a body with `implementTool` (AIP-30):

```ts
import { createAgent, defineTool, implementTool } from "@agentproto/sdk"
import { z } from "zod"

const weather = implementTool(
  defineTool({
    id: "weather",
    description: "Get weather",
    inputSchema: z.object({ city: z.string() }),
  }),
  async ({ input }) => ({ city: input.city, tempC: 21 }),
)

const agent = createAgent({
  id: "greeter",
  model: "anthropic/claude-sonnet-5",
  tools: [weather],
})

console.log(await agent.run("Weather in Paris?"))
```

A bare `ToolHandle` is still advertised to the model; if the model calls it,
the run emits a `tool-error` telling you to bind an implementation.

## What's in the box

| Import | Re-exported from |
| --- | --- |
| `defineTool`, `ToolHandle`, … | `@agentproto/tool` (AIP-14) |
| `defineAgent`, `loadAgent`, `AgentHandle`, … | `@agentproto/agent` (AIP-42) |
| `implementTool`, `runTool`, `ToolImplementation`, … | `@agentproto/driver` (AIP-30) |
| `createAgent` | this package |

Subpath exports keep the heavier runtime pieces tree-shakeable:

```ts
// AIP-44 - drive/expose an ACP agent.
import { createAcpClient, createAcpServer } from "@agentproto/sdk/acp"

// The long-running gateway (MCP + HTTP + heartbeat).
import { createGateway } from "@agentproto/sdk/server"
```

Both subpaths need their peer installed: `@agentproto/acp` and
`@agentproto/runtime` respectively. They are optional peers, so a tool author
importing the root never pays for the daemon.

## `createAgent`

```ts
const agent = createAgent({ id, model, tools })

await agent.run(prompt)        // → final assistant text
agent.stream(prompt)           // → AsyncGenerator<AgentStreamEvent, string>
agent.stop()                   // abort every in-flight run
```

Options:

| Option | Meaning |
| --- | --- |
| `id` | AIP-42 id (validated by the same rules as `defineAgent`). |
| `model` | Provider/model id, passed through to the completion call. |
| `tools` | `ToolHandle` (contract only) or `implementTool(...)` (callable). |
| `system` / `instructions` | System prompt prepended to every run. |
| `maxSteps` | Model round-trips before the run gives up (default 8). |
| `temperature` | Sampling temperature. |
| `complete` | Replace the default completion call entirely. |
| `baseUrl` / `apiKey` / `headers` | OpenAI-compatible endpoint settings. |
| `fetch` | Injectable `fetch` for tests or custom transports. |

By default the model is called through an OpenAI-compatible
`POST /chat/completions` endpoint:

- `baseUrl` ← `AGENTPROTO_BASE_URL` / `OPENAI_BASE_URL` (default
  `https://api.openai.com/v1`)
- `apiKey` ← `AGENTPROTO_API_KEY` / `OPENAI_API_KEY`
- `fetch` ← the global `fetch` (Node 18+)

`stream()` yields `start`, `assistant`, `tool-call`, `tool-result` /
`tool-error`, and `done` events. `run()` consumes the same loop and returns the
`done` text.

## License

Apache-2.0
