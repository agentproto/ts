# @agentproto/mastra

AIP-42 `AGENT.md` → Mastra runtime adapter. Reference implementation
for the **agent/v1 → live agent** path against the Mastra framework.

```bash
pnpm add @agentproto/mastra @agentproto/agent @mastra/core
```

## Why

`@agentproto/agent` parses an `AGENT.md` and gives you a typed
`AgentHandle`. That's the spec layer. To actually *run* the agent,
something has to translate ref strings (`anthropic/claude-opus-4-7`,
`@agentik/tools-standard/web-fetch`, `per-conversation` memory scope)
into runtime objects.

This package is that something for Mastra.

## Usage

```ts
import { readFile } from "node:fs/promises"
import { parseAgentManifest, agentFromManifest } from "@agentproto/agent"
import { buildMastraAgent } from "@agentproto/mastra"
import { openai } from "@ai-sdk/openai"
import { anthropic } from "@ai-sdk/anthropic"
import { Memory } from "@mastra/memory"
import { weatherTool } from "./tools/weather"

const source = await readFile("./.agents/writer/AGENT.md", "utf8")
const parsed = parseAgentManifest(source)
const handle = agentFromManifest(parsed)

const { agent, resolvedTools, droppedTools, instructions } =
  await buildMastraAgent(handle, {
    body: parsed.body,
    resolveModel: (ref) => {
      const id = typeof ref === "string" ? ref : (ref.ref ?? "")
      const [provider, model] = id.split("/", 2)
      if (provider === "anthropic") return anthropic(model!)
      if (provider === "openai") return openai(model!)
      throw new Error(`unknown model provider: ${provider}`)
    },
    resolveTool: (ref) => {
      const id = typeof ref === "string" ? ref : (ref.ref ?? "")
      if (id === "weather") return { name: "weather", tool: weatherTool }
      return undefined // dropped with a warning
    },
    buildMemory: (cfg) => new Memory({ /* translate cfg fields */ }),
  })

console.log(`built agent '${agent.name}' with ${resolvedTools.length} tools`)
const reply = await agent.generate("draft a 200-word brief on…")
```

## Resolvers

The package never bundles a model provider, tool catalog, or memory
backend. You provide:

| Option | Required | Purpose |
|---|---|---|
| `resolveModel(ref)` | yes | Translate `model:` → AI-SDK `LanguageModel` |
| `resolveTool(ref)` | no | Translate `tools[]` → Mastra tools |
| `resolveWorkflow(ref)` | no | Validate `workflows[]` exist (not attached to agent) |
| `buildMemory(cfg)` | no | Build a Mastra `Memory` from `memory:` |
| `buildVoice(handle)` | no | Build a voice provider (ElevenLabs, etc.) |
| `formatInstructions` | no | Override how body + boundaries become a system prompt |
| `body` | no | The markdown body (everything after frontmatter) |
| `strict` | no | Throw on unresolved tools instead of warn-and-drop |

## Default instructions composer

`composeInstructions(handle, body)` produces:

```
{body or description}

{persona inline block if present}

Hard rules — these MUST be followed:
- {boundary 1}
- {boundary 2}

Trait scores (0-10): rigor=9, warmth=4.
```

Override with `formatInstructions: (handle, body) => string` if your
host has its own prompt assembly (e.g. multi-agent council headers,
per-tenant pre-amble, i18n).

## Diagnostics

`buildMastraAgent` returns the live `Agent` plus:

- `resolvedTools: string[]` — names that wired in
- `droppedTools: string[]` — refs the resolver returned `undefined` for
- `resolvedWorkflows: string[]` / `droppedWorkflows: string[]`
- `instructions: string` — the final composed prompt

Useful for diagnostics UIs (which tools were declared on the manifest
but missing from the host's catalog?) and tests.

## License

MIT.
