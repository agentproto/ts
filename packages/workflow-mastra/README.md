# @agentproto/workflow-mastra

Project an AIP-15 `WORKFLOW.md`'s compiled [`RuntimeWorkflow`](../workflow-runtime)
onto a [Mastra](https://mastra.ai) `createWorkflow`. Runtime projection, not
codegen — same one-level-up relationship
[`toMastraTool`](../../adapters/mastra) has to `implementTool`.

> **Status: 0.1.0-alpha.** Design spec: `packages/workflow/README.md` §A in
> this repo's history (PR #672 / this package's PR).

## Usage

```ts
import { compileWorkflowManifest } from "@agentproto/workflow-runtime"
import { toMastraWorkflow } from "@agentproto/workflow-mastra"

const compiled = compileWorkflowManifest(workflowMdSource, { tools, candidates })
const mastraWorkflow = toMastraWorkflow(compiled, { agents: mySessionHost })

const run = await mastraWorkflow.createRunAsync()
const result = await run.start({ inputData: { chatId: "…" } })
```

## Step-kind mapping

| `RunStep.kind` | Mastra primitive |
|---|---|
| `tool` | `createStep({execute})` wrapping the same `runTool` dispatch the engine itself uses |
| `transform` | `createStep({execute})` calling the step's `compute` selector |
| `agent` | `createStep({execute})` delegating to `@agentproto/workflow-runtime`'s own `AgentStep` executor via a one-step sub-run (reuses the spawn/prompt/policy/outputSchema-retry logic instead of re-implementing it) |
| `group` | one wrapper `createStep` running the group's children through a local step-walker, so later top-level siblings still see their outputs (matches the engine's shared-bindings model) |
| `branch` | `.branch([[cond, thenStep], [negatedCond, elseStep]])` |
| `parallel` | `.parallel([...branchSteps])` |
| `map` | `.foreach(bodyStep, { concurrency })` |
| `loop` | `.dowhile(bodyStep, condition)` — `condition` combines `LoopStep.while` with Mastra's native `iterationCount`, so `maxIterations` is enforced without a synthetic counter step |
| `subworkflow` | delegates to `runWorkflow` for the child (isolated bindings, matching `SubworkflowStep`'s own documented semantics) |
| `suspend`, `approval` | **not projectable** — `toMastraWorkflow` throws `WorkflowProjectionError` eagerly, before building anything |

`pipeline` (a `workflow-runtime`-only fan-out kind not covered by the design
spec this package implements) also fails loud rather than silently
degrading to `map` semantics it doesn't have.

## Known limitations

- Composite step bodies (`branch`/`map`/`loop`/`group`) run through a small
  local step-walker rather than further Mastra sub-workflows, so a nested
  body CAN read `$input` / `$item` / `$index` and any sibling bound earlier
  in the SAME run.
- `parallel` branches run concurrently, and Mastra's per-run `state` has no
  compare-and-swap — two branches merging into it at once would silently
  lose one branch's write. So a `parallel` branch's own nested step ids are
  visible to LATER steps within the SAME branch, but not to anything outside
  the `parallel` block; only the branch's own final output (keyed by branch
  id, via Mastra's own concurrency-safe result aggregation) binds under the
  `ParallelStep`'s id.
- An `AgentStep`'s selectors (delegated to an isolated one-step `runWorkflow`
  sub-run for full parity with the engine's own spawn/prompt/policy/retry
  executor) only see `$input`, not `$steps.<id>`.
- `map` bodies don't get `$index` (Mastra's `.foreach()` doesn't expose the
  element's index to the body step).

Flagged, not solved here — same spirit as the design spec's own documented
gaps (`packages/workflow/README.md`).

## License

Apache-2.0 — see [LICENSE](./LICENSE).
