# @agentproto/harness

Typed presets for spinning up agentproto agent sessions in one call.

## Install

```sh
pnpm add @agentproto/harness
```

## Quick-starts

### Coder (claude-code / opus)

```ts
import { connectHarness, createCoderHarness } from "@agentproto/harness"

const dx = await connectHarness()
const coder = await createCoderHarness(dx, {
  workspace: "/path/to/repo",
  context: { stack: "TypeScript, pnpm", gateCmds: ["pnpm check-types"] },
})

const result = await coder.ask("Implement the Widget component")
console.log(result)
await coder.kill()
```

### Coder (hermes + deepseek-v4-pro, cheaper)

```ts
const coder = await createCoderHarness(dx, {
  workspace: "/path/to/repo",
  engine: "hermes",   // → deepseek/deepseek-v4-pro via OpenRouter
  context: { gateCmds: ["pnpm test"] },
})
```

### Researcher (hermes + GLM-5.2, large context)

```ts
import { createResearcherHarness } from "@agentproto/harness"

const researcher = await createResearcherHarness(dx, {
  // default model: z-ai/glm-5.2 via OpenRouter (1M+ context)
})

const report = await researcher.ask("Research the top 5 vector DB options in 2025")
```

### Supervisor (claude-code opus, orchestrates sub-agents)

```ts
import { createSupervisorHarness } from "@agentproto/harness"

const supervisor = await createSupervisorHarness(dx, {
  workspace: "/path/to/repo",
  workPackages: [
    { id: "WP1", title: "Add auth middleware", description: "...", gate: "pnpm test" },
    { id: "WP2", title: "Write tests", description: "...", gate: "pnpm test" },
  ],
})

await supervisor.waitForTurn({ timeoutMs: 120_000 })
const tree = await supervisor.subtree()
```

## Prerequisites

- agentproto daemon running (`agentproto serve`) on port 18790
- For hermes models: `OPENROUTER_API_KEY` set in the daemon's environment