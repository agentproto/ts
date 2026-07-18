# @agentproto/app-kit

Declare an **agent** (with its system prompt) and the **workflows** it runs in
one TypeScript module, then import them anywhere.

A thin umbrella over AIP-42 [`defineAgent`](../agent) + AIP-15
[`defineWorkflow`](../workflow). It doesn't re-validate their fields — those ran
when you built the handles — it validates the *coupling* and gives you two ways
to consume the bundle: a runnable Mastra agent, or emitted `.md` manifests.

```ts
import { defineApp } from "@agentproto/app-kit"
import { defineAgent } from "@agentproto/agent"
import { defineWorkflow } from "@agentproto/workflow"

export const reviewApp = defineApp({
  agent: defineAgent({
    schema: "agent/v1",
    id: "@agentik/reviewer",
    description: "Reviews a PR diff and reports findings.",
    model: "claude-sonnet-5",
    boundaries: ["Never run gh pr merge", "No AI attribution in commits"],
    workflows: [{ ref: "review-and-fix" }], // ← must match a bundled workflow
  }),
  systemPrompt: `You are a rigorous PR reviewer. Report findings; change nothing.`,
  workflows: [
    defineWorkflow({
      id: "review-and-fix",
      name: "Review and fix",
      description: "Read the diff, report findings.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [{ id: "review", kind: "tool", tool: "read_diff" }],
    }),
  ],
})
```

## The attachment invariant

`defineApp` enforces a bijection between `agent.workflows[]` and the bundled
workflows: every ref the agent lists must be bundled, and every bundled workflow
must be listed. A dangling ref or an orphan workflow throws `AppDefinitionError`.
That coupling is what "an agent attached to its workflows" means, made checkable
at construction.

## Consuming a bundle

### `handle.toMastraAgent(resolvers)` — run it

Turns the AGENT.md **body (your `systemPrompt`) into a real Mastra `instructions`
field** via [`@agentproto/mastra`](../mastra). You supply the resolvers (model,
tools, memory…); app-kit injects the system prompt as the body.

```ts
const { agent, instructions } = await reviewApp.toMastraAgent({
  resolveModel: (ref) => myModelRegistry.resolve(ref),
})
```

`@mastra/core` is a **peer dependency** — install it in the host if you call
`toMastraAgent`. `emit` has no Mastra dependency.

### `handle.emit(dir)` — ship it

Writes the manifests the daemon and the `agentproto-run` CI lane load:

```
<dir>/.agents/reviewer/AGENT.md
<dir>/.agents/reviewer/workflows/review-and-fix/WORKFLOW.md
```

Both are plain markdown: frontmatter = the validated handle, body = the system
prompt (AGENT.md) / description (WORKFLOW.md). Because a `defineWorkflow` handle
is pure data, the `WORKFLOW.md` needs no `entry:` module — the manifest *is* the
workflow, so `loadWorkflowHandle` returns it directly.

## Runtime note

`toMastraAgent` is the path where the system prompt becomes a **true** model
`instructions` field, because that wiring lives in the mastra adapter. The
generic daemon session-spawn has no system-prompt field today (instructions ride
in as prepended prompt text for CLI adapters), so an emitted AGENT.md reaches the
model as a real system prompt only through a mastra-family runtime.
