# @agentproto/workflow-ai-sdk

Project an AIP-15 `WORKFLOW.md`'s compiled [`RuntimeWorkflow`](../workflow-runtime)
onto a Vercel AI SDK `dynamicTool`. AI SDK has no first-class step-graph
primitive — its unit is a tool-calling loop — so the whole compiled workflow
runs through `@agentproto/workflow-runtime`'s own `runWorkflow` behind ONE
tool call (whole-workflow-as-one-tool), not a step-by-step mapping.

> **Status: 0.1.0-alpha.** Design spec: `packages/workflow/README.md` §A in
> this repo's history (PR #672 / this package's PR).

## Usage

```ts
import { compileWorkflowManifest } from "@agentproto/workflow-runtime"
import { toAiSdkWorkflowTool } from "@agentproto/workflow-ai-sdk"
import { generateText } from "ai"

const compiled = compileWorkflowManifest(workflowMdSource, { tools, candidates })
const workflowTool = toAiSdkWorkflowTool(compiled, { agents: mySessionHost })

await generateText({ model, tools: { [compiled.id]: workflowTool }, prompt: "…" })
```

## Unmapped kinds

A workflow whose step graph contains `suspend` or `approval` anywhere
(including nested inside a `subworkflow`) can't fit a single opaque tool
call — there's no external resume path back into a mid-run AI SDK tool
invocation. `toAiSdkWorkflowTool` walks the compiled step graph eagerly at
wrap time and throws `WorkflowProjectionError` for those, and for `pipeline`
(a `workflow-runtime`-only kind not covered by the design spec this package
implements), instead of silently dropping them or failing only once the
workflow happens to reach that step at run time.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
