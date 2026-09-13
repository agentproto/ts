# @agentproto/workflow-runtime

The execution engine for AIP-15 **WORKFLOW** — a typed step algebra plus the
interpreter that walks it. A workflow is an ordered list of steps; each step
reads the run-scoped bindings (the workflow input + every prior step's output)
through a plain `(bindings) => value` selector, runs, and binds its own output
back under its `id` for later steps to read.

There is **no DSL and no manifest parser here** — you author workflows as
TypeScript values. Compiling a declarative AIP-15 manifest's reference strings
onto these selectors is a separable layer on top.

```bash
npm install @agentproto/workflow-runtime
```

## Quick start

```ts
import { runWorkflow, type RuntimeWorkflow } from "@agentproto/workflow-runtime"
import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { defineDriver, implementTool } from "@agentproto/driver"

const double = defineTool({
  id: "demo.double",
  description: "Double a number.",
  inputSchema: z.object({ n: z.number() }),
  outputSchema: z.object({ n: z.number() }),
})
const math = defineDriver({
  id: "math",
  name: "Math",
  description: "arith",
  kind: "builtin",
  implements: [{ tool: "demo.double", version: "0.1.0" }],
  implementations: [implementTool(double, ({ input }) => ({ n: input.n * 2 }))],
})

const wf: RuntimeWorkflow = {
  id: "double-then-add",
  steps: [
    { kind: "tool", id: "d", tool: double, candidates: [math], input: () => ({ n: 21 }) },
    { kind: "transform", id: "plus", compute: (b) => ({ n: (b.steps.d as { n: number }).n + 0 }) },
  ],
  output: (b) => b.steps.plus,
}

const { output, bindings } = await runWorkflow({ workflow: wf })
//    output === { n: 42 };  bindings.steps.d === { n: 42 }
```

`runWorkflow(args)` returns `{ output, bindings }`. `output` is the workflow's
`output` selector, or the last top-level step's output if you omit it.

## Step kinds

Every step reads `Bindings` (`{ input, steps, item?, index? }`) via selectors
and binds its output under `id`.

| kind | what it does |
| --- | --- |
| `tool` | Resolve a TOOL contract against `candidates` and run it. Cacheable. |
| `agent` | Spawn/reuse an agent session, send a prompt, wait for the turn. Cacheable. |
| `transform` | Pure in-run compute — combine / filter / shape. No dispatch. |
| `map` | Run a body once per array element (`bindings.item` / `index`); collect outputs. Fail-fast by default; `onError: "collect"` opts into per-item tolerance. |
| `pipeline` | Run N items through K sequential stages with **no cross-item barrier**. Same `onError: "collect"` opt-in as `map`. |
| `parallel` | Run several named branches concurrently; outputs bind by branch id. |
| `branch` | Pick `then` / `otherwise` from a boolean predicate. |
| `loop` | Repeat a body while a predicate holds, up to `maxIterations`. |
| `approval` | AIP-7 human gate — host `approve` callback decides. |
| `suspend` | Pause until an external event; host `resume` supplies the payload. |
| `group` | Run a list of steps as one unit; output is the last step's. |
| `subworkflow` | Run a nested workflow with its own isolated bindings. |

## Harness-parity capabilities

The engine reaches parity with a code-first agent harness across five axes.
Each is opt-in and composes with the rest.

### Engine unification

Every construct above — including `agent`, `pipeline`, and `subworkflow` — is
walked by the **one** `execStep` interpreter. There is no second code path for
agents vs. tools vs. control flow; budget, caching, and IO-threading apply
uniformly wherever a step runs (top-level, inside a `pipeline` stage, inside a
`map` body, inside a `subworkflow`).

### Structured output (agent steps)

Give an `agent` step an `outputSchema` and the engine validates the session's
final message against it, **re-prompting on mismatch** up to `maxRetries`
(default 2). The step's bound output is `{ sessionId, output }` where `output`
is the parsed, schema-valid value.

Without `outputSchema`, an agent step whose host implements `readFinalMessage`
binds `{ sessionId, text }`, where `text` is the session's final assistant
message. The runtime uses that `text` to thread prior agent-step output into
later agent prompts automatically, so multi-step workflows can share context
without manual selector plumbing.

```ts
const Verdict = z.object({
  verdict: z.enum(["real", "false-positive"]),
  reason: z.string(),
})

const wf: RuntimeWorkflow = {
  id: "review-one",
  steps: [
    {
      kind: "agent",
      id: "judge",
      adapter: "claude-code",
      prompt: (b) => `Judge this diff and reply as JSON:\n${b.input}`,
      outputSchema: Verdict,
      maxRetries: 2,
    },
  ],
  output: (b) => b.steps.judge,
}
// → { sessionId: "sess_…", output: { verdict: "real", reason: "off-by-one" } }
```

Requires a host that implements `readFinalMessage` (see **AgentSessionHost**).

### Aggregate budget ceiling

`maxTotalCostUsd` caps the summed cost of every spawned session across the whole
run. Before each `agent` spawn the engine sums `readCostUsd` over live sessions;
once the total would reach the cap, the spawn fails with `budget_exceeded` —
so a runaway fan-out stops instead of draining the account.

```ts
await runWorkflow({ workflow: wf, agents: host, maxTotalCostUsd: 5.0 })
// throws: step 's2': budget_exceeded — run spend $5.40 >= cap $5
```

### Pipeline mode (no cross-item barrier)

`kind: "pipeline"` runs each item through the stages as its **own** chain —
item A can be in stage 3 while item B is still in stage 0. Wall-clock is the
slowest single-item chain, not the sum of per-stage barriers. `concurrency`
caps how many item-chains are in flight; outputs bind ordered by item index.

```ts
{
  kind: "pipeline",
  id: "review",
  over: (b) => b.input as string[],          // the files to review
  concurrency: 4,
  stages: [
    (file) => ({ kind: "agent", id: "find", adapter: "claude-code",
                 prompt: () => `Review ${file}`, outputSchema: Findings }),
    (file, _i, prev) => ({ kind: "agent", id: "verify", adapter: "claude-code",
                 prompt: () => `Adversarially verify: ${JSON.stringify(prev)}`,
                 outputSchema: Verdict }),
  ],
}
```

Each stage body is `(item, index, prevOutput, bindings) => RunStep`; `prevOutput`
is the previous stage's output **for that item** (undefined at stage 0). Use a
`parallel` step instead only when a later stage genuinely needs *all* prior
results at once (a barrier).

### Per-item failure tolerance (`map` / `pipeline`)

By default, `map` and `pipeline` are **fail-fast**: the first item whose body
(or chain, for `pipeline`) throws aborts the whole step, and every other
in-flight item's result is discarded. That's correct when any failure should
halt the run — but wrong when failure is an expected per-item outcome (an
expired listing, a 404, a flaky endpoint) and the other N-1 items are still
useful output.

Set `onError: "collect"` to run every item to completion instead. The step's
bound output changes shape from a bare array to a `TolerantFanOutResult`:

```ts
{
  kind: "map", // or "pipeline"
  id: "details",
  over: (b) => b.input as string[],
  onError: "collect",
  body: (url) => ({ kind: "tool", id: "fetch", tool: fetchDetail, candidates,
                     input: () => ({ url }) }),
}
// → {
//     results: [
//       { status: "fulfilled", index: 0, value: {...} },
//       { status: "rejected",  index: 1, item: "https://…/410", error: "expired" },
//       { status: "fulfilled", index: 2, value: {...} },
//     ],
//     succeeded: 2,
//     failed: 1,
//   }
```

`succeeded` + `failed` answer "how many items failed" without scanning
`results`; each rejected entry carries the offending `item` and `error.message`
(or `String(reason)` for a non-`Error` throw) so a caller can answer "why"
without having watched the run. The default (`onError` omitted, or explicitly
`"throw"`) is byte-for-byte the old behavior — this is opt-in, not a breaking
change to existing workflows.

### Resume cache (journaled replay)

Mark an idempotent `tool` or `agent` step `cacheable: true`, pass a `cache` and
a `cacheKey`, and the engine journals its output. On a re-run with the same
`cacheKey`, a cacheable step whose **resolved inputs are unchanged** replays
from the journal instead of re-dispatching — no tool call, no session spawn, no
budget spend. The cache key hashes `(step.kind, resolved inputs)`; a `tool`
hashes its `input`, an `agent` hashes its resolved `prompt` + `adapter` +
`sessionRef`.

```ts
import { createFileStepCache } from "@agentproto/runtime" // file-backed, ~/.agentproto/workflow-cache/

const cache = createFileStepCache("nightly-review")
await runWorkflow({ workflow: wf, cache, cacheKey: "nightly-review" }) // run 1: executes
await runWorkflow({ workflow: wf, cache, cacheKey: "nightly-review" }) // run 2: unchanged steps replay
```

Both `cache` and `cacheKey` must be set for any caching to happen. Supply your
own `StepCache` (`{ get, set }`) for an in-memory or custom-backed journal.

### Step lifecycle callbacks

Pass `onStepStart` and `onStepComplete` to `runWorkflow` to observe progress in
real time. The callbacks fire for every step kind; for `agent` steps, start fires
before spawn and complete fires after the turn (and any output-schema retry loop)
finishes.

```ts
await runWorkflow({
  workflow: wf,
  onStepStart: (stepId) => console.log("starting", stepId),
  onStepComplete: (stepId, output) => console.log("done", stepId, output),
})
```

## AgentSessionHost — the host seam

The runtime has **no** knowledge of concrete session registries or event buses.
`agent` steps drive an injected `AgentSessionHost`:

```ts
interface AgentSessionHost {
  spawn(
    adapter: string,
    opts: {
      cwd?
      workspaceSlug?
      stepId?
      /** AIP-36 sandbox ref (provider slug or inline spec). */
      sandbox?
      /** Adapter option id → value, e.g. for an app-scoped agent resolution. */
      options?: Record<string, boolean | number | string>
    },
  ): Promise<string>
  sendPromptAndWait(sessionId: string, prompt: string): Promise<void>
  resolveByLabel(stepId: string): string | undefined  // for sessionRef reuse
  onAwaitingInput?(sessionId, policy): Promise<void>
  readFinalMessage?(sessionId): Promise<string>        // required for outputSchema; also supplies `text` output
  readCostUsd?(sessionId): Promise<number>             // required for maxTotalCostUsd
}
```

With no host, `agent` steps throw. `@agentproto/runtime` ships a production host
(`SessionsRegistryAgentHost`) backed by the real sessions registry + event bus,
and `createFileStepCache` for the journal — both wired end-to-end behind the
daemon's `workflow_start` MCP tool.

## Where this runs

- **Embed it** — import `runWorkflow` and inject your own host for the full step
  algebra and all five capabilities above.
- **Through the daemon** — `@agentproto/runtime`'s `WorkflowRunner` translates
  the MCP `workflow_start` stage/barrier shape onto this engine. That surface
  exposes agent-session stages + resume-cache today; `pipeline`, `outputSchema`,
  and `maxTotalCostUsd` are available on the embedding path. See the CLI docs'
  **Workflows** concept page.

## Spec

AIP-15 (WORKFLOW) — `agentproto/specs`. The manifest pins the abstract shape
(named steps, branching, parallelism, approval gates, suspend/resume, budget);
this package is the execution seam beneath it.
