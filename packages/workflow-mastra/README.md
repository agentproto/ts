# @agentproto/workflow-mastra

Project an AIP-15 `WORKFLOW.md`'s compiled [`RuntimeWorkflow`](../workflow-runtime)
onto a [Mastra](https://mastra.ai) `createWorkflow`. Runtime projection, not
codegen — same one-level-up relationship
[`toMastraTool`](../../adapters/mastra) has to `implementTool`.

> **Status: 0.1.0-alpha.** Design spec: `packages/workflow/README.md` §A in
> this repo's history (PR #672 / this package's PR).

## Usage

```ts
import { Mastra } from "@mastra/core"
import { compileWorkflowManifest } from "@agentproto/workflow-runtime"
import { toMastraWorkflow } from "@agentproto/workflow-mastra"

const compiled = compileWorkflowManifest(workflowMdSource, { tools, candidates })
const mastraWorkflow = toMastraWorkflow(compiled, {
  agents: mySessionHost,
  // The manifest's own `inputs` block (shorthand or JSON Schema) — a compiled
  // `RuntimeWorkflow` doesn't carry it forward, so pass it through to get
  // real `invalid-input` rejection instead of `z.any()`.
  inputsSchema: parsedManifest.inputs,
})

// suspend/resume needs storage to look its run snapshot up from — register
// with a `Mastra` instance (any adapter; the default in-memory store is fine
// for a process-local run) if the workflow has a top-level `suspend`/`approval` step.
const mastra = new Mastra({ workflows: { [mastraWorkflow.id]: mastraWorkflow } })
const run = await mastra.getWorkflow(mastraWorkflow.id).createRun()
const result = await run.start({ inputData: { chatId: "…" } })
```

## Step-kind mapping

| `RunStep.kind` | Mastra primitive |
|---|---|
| `tool` | `createStep({execute})` wrapping the same `runTool` dispatch the engine itself uses; `outputSchema` is the TOOL contract's real `outputSchema` (or its JSON-Schema `outputs`, converted) when declared |
| `transform` | `createStep({execute})` calling the step's `compute` selector |
| `agent` | `createStep({execute})` delegating to `@agentproto/workflow-runtime`'s own `AgentStep` executor via a one-step sub-run (reuses the spawn/prompt/policy/outputSchema-retry logic instead of re-implementing it); when the step declares an `outputSchema`, the Mastra step's `outputSchema` is `{ sessionId, output: <declared> }` — the REAL shape `execute()` returns, not the bare declared schema |
| `group` | one wrapper `createStep` running the group's children through a local step-walker, so later top-level siblings still see their outputs (matches the engine's shared-bindings model) |
| `branch` | `.branch([[cond, thenStep], [negatedCond, elseStep]])` |
| `parallel` | `.parallel([...branchSteps])` |
| `map` | `.foreach(bodyStep, { concurrency })` |
| `loop` | `.dowhile(bodyStep, condition)` — `condition` combines `LoopStep.while` with Mastra's native `iterationCount`, so `maxIterations` is enforced without a synthetic counter step |
| `subworkflow` | delegates to `runWorkflow` for the child (isolated bindings, matching `SubworkflowStep`'s own documented semantics) |
| `suspend` (top-level only) | native Mastra `suspend()`/`resume()` — see [Suspend and approval](#suspend-and-approval) |
| `approval` (top-level only) | native Mastra `suspend()`/`resume()`, then runs `onApprove`/`onReject` through the local walker — see below |
| `suspend`, `approval` (nested inside a `branch`/`parallel`/`loop`/`map`/`group`) | **not projectable** — no per-step Mastra suspend boundary to attach to inside an enclosing opaque step; throws `WorkflowProjectionError` eagerly |
| `gate` | **not projectable** — see [Gate](#gate) |
| `pipeline` | **not projectable** — a `workflow-runtime`-only fan-out kind not covered by the design spec this package implements; NOT silently downgraded to `map` semantics it doesn't have |

### Schemas

The projected workflow's own `inputSchema` (on `createWorkflow`) is built from
`opts.inputsSchema` (the manifest's `inputs` block) via
`normalizeWorkflowInputsSchema` + a small local JSON-Schema→zod converter
(`json-schema-to-zod.ts`; object/string/number/boolean/enum/array/required —
falls back to `z.any()` for anything it can't represent faithfully, e.g.
`oneOf`/`$ref`). `run.start()` rejects invalid `inputData` against it BEFORE
any step's `execute` runs — the same `invalid-input` semantics as
`validateWorkflowInput`; `mapMastraInputError` translates Mastra's own thrown
`MastraError` (`id: "WORKFLOW_SCHEMA_VALIDATION_FAILED"`) back to that shape.
Object conversion is deliberately LOOSE (`z.looseObject`, not `z.object`):
Mastra's `inputSchema` re-parses `inputData`, and a strict object schema
would silently strip any input field the manifest's `inputs` block doesn't
declare — before a single step ever reads it via `$input.*`.

Every PER-STEP `inputSchema` stays `z.any()`, regardless of kind — this is
deliberate, not an oversight. Mastra validates a step's `inputSchema` against
`params.inputData`, which is the MECHANICALLY preceding Mastra step's raw
output; every wrapper in this package computes its real input from the run's
shared `bindings` via a selector instead (the whole point of the AIP-16 IO
seam — non-linear `$steps.<id>` reads), so `inputData` never corresponds to a
step's actual input once a workflow has more than one step. Setting a real
`inputSchema` there doesn't add safety, it breaks chaining (verified: Mastra
throws `WORKFLOW_STEP_INPUT_VALIDATION_FAILED` on the very first multi-step
fixture). `runTool` already validates a tool's real input at the correct
layer, before dispatch.

### Suspend and approval

A top-level `suspend`/`approval` step (a direct child of the workflow, not
nested in a `branch`/`parallel`/`loop`/`map`/`group`) gets its own Mastra step
with real `suspendSchema`/`resumeSchema`, using Mastra's native
`params.suspend()` / `run.resume({ step, resumeData })` — no more re-running
the whole workflow from a persisted `WorkflowSuspendedError`. `suspend`
resumes with the raw resume payload (bound under the step's id, matching
`run-workflow.ts`'s own `ctx.resume({stepId, on})` contract); `approval`
resumes with an `{approved, who, note?}` decision and then runs
`onApprove`/`onReject` through the local walker, merging their outputs into
the shared `$steps` bindings exactly like `run-workflow.ts`'s own `"approval"`
case. Unlike the plain runtime (which auto-approves when no `approve` hook is
given), the projected `approval` step ALWAYS suspends — Mastra has no
per-projection equivalent of a per-run `approve` callback to fall back to; a
caller wanting auto-approve resumes immediately with
`{approved: true, who: "host"}` itself.

`run.resume()` looks its run up from storage, so a workflow with a top-level
suspend/approval needs to be registered with a `Mastra` instance (see
Usage above) — `toMastraWorkflow` builds the workflow but deliberately
doesn't own storage or other host wiring.

Nested inside a composite, `suspend`/`approval` stay refused: they'd run
through the local step-walker inside an ENCLOSING opaque step's `execute`,
which has no Mastra step of its own to call `suspend()` from.

### Gate

`kind: "gate"` is refused, everywhere, with an explicit reason — not faked.
`run-workflow.ts`'s real `GateStep` executor resolves `$input`/`$item`/
`$steps.<id>` ref-string args and cwd, and drives its `onFail.reprompt` retry
through the SAME private machinery (`resolveRefString`, the default
`execFile`-backed command runner) — none of it is a public seam this package
can import and reuse. Re-implementing that resolution grammar here, separate
from the canonical implementation, would silently drift from it rather than
run the identical gate a daemon run would.

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
