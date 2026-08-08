# @agentproto/workflow

AIP-15 `WORKFLOW.md` reference implementation. A markdown + frontmatter format for declaring a multi-step agent workflow's abstract orchestration shape — its steps, branching, parallelism, approval gates, suspend/resume, and compensation. Pairs with the standard `defineWorkflow` / `defineStep` signatures. Implementation lives entirely in the per-step TOOL.md contracts and their AIP-30 DRIVER bindings; workflows themselves are pure orchestration data.

> **Status: 0.2.0-alpha.** `defineWorkflow` and `parseWorkflowManifest` are implemented;
> see `src/index.ts` for the authoring paths.

Spec: <https://agentproto.sh/docs/aip-15>

## Usage

```ts
import { defineWorkflow } from "@agentproto/workflow"

const x = defineWorkflow({
  id: "my-workflow",
  description: "Short purpose.",
  // ...
})
```

## Design specs (follow-up — NOT implemented here)

Two design-only proposals, written while wiring the daemon's WORKFLOW.md
`tool`-step registry (`packages/runtime/src/workflow-tool-registry.ts`) and
dogfooding it (`packages/worktree/routines/worktree-gc-notify/`). Grounded in
what exists today; nothing below is implemented by that change.

### A. Export/import: WORKFLOW.md ⇄ Mastra `createWorkflow` / Vercel AI SDK

**What already exists.** Per-TOOL projection is real, at the `ToolImplementation`
level (`implementTool(tool, body)` from `@agentproto/driver`):
`@agentproto/adapter-mastra`'s `toMastraTool(impl, opts)`
(`adapters/mastra/src/index.ts:98`) adapts one implementation to Mastra's
`createTool`; `@agentproto/adapter-ai-sdk`'s `toAiSdkTool(impl, opts)`
(`adapters/ai-sdk/src/index.ts:74`) adapts the same shape to AI SDK's
`dynamicTool`. Both are runtime wrappers (call-time projection), not codegen.

At the WORKFLOW level, there is a *different* precedent worth reusing the
shape of, not the mechanism: `packages/agencies/mastra/src/codegen.ts`'s
`procedureToWorkflow(procedure)` reads a PROCEDURE.md doctype and emits a
`.ts` **source file** the app commits, calling `@mastra/core/workflows`'
`createWorkflow({ id, steps: {...} })` — currently a phase-1 skeleton (one
TODO-stub Mastra step per procedure step; branch/signature-gate emission is
still a comment, not real `.then/.branch` chaining). No projector builds a
Mastra workflow **object** from a `RuntimeWorkflow` at runtime today.
`packages/mastra` (AIP-42 AGENT.md → Mastra) has a `WorkflowResolver` type an
agent can use to *attach* an externally-built workflow, but
`MastraWorkflowLike = unknown` (`packages/mastra/src/types.ts:27`) — it
resolves a ref to *some* workflow object, it doesn't build one.

**Proposed shape — runtime projection, not codegen.** A `RuntimeWorkflow`
(the `compileWorkflow` output) already carries live `ToolHandle` +
`DriverHandle[]` candidates per tool step — the same inputs `runTool` already
dispatches. That argues for a `@agentproto/workflow-mastra` package, sibling
to `adapter-mastra`, exposing `toMastraWorkflow(compiled, opts):
MastraWorkflow` that wraps a compiled `RuntimeWorkflow` at call time — same
one-level-up relationship `toMastraTool` has to `implementTool`. Codegen (the
procedure-mastra approach) fits PROCEDURE.md because a generated file is
meant to be hand-customized after generation; a WORKFLOW.md's steps are
meant to run as declared, so there is nothing to hand-edit — runtime
projection is the better fit here.

Step-kind → Mastra primitive (`RunStep` kinds, `packages/workflow-runtime/src/types.ts`):

| `RunStep.kind` | Mastra primitive | Notes |
|---|---|---|
| `tool` | `createStep({execute})` wrapping `runTool` | Same dispatch as today — no new path. Chained via `.then(step)`. |
| `group` | flattened `.then().then()...` | |
| `branch` | `.branch([[cond, then], [elseCond, otherwise]])` | `cond` wraps the step's `Selector<boolean>` reading Mastra's run context in place of `Bindings`. |
| `parallel` | `.parallel([...branches])` | Direct match. |
| `map` | `.foreach(step, { concurrency })` | `concurrency` ← `MapStep.parallelism`. |
| `loop` | `.dowhile(step, cond)` / `.dountil` | Mastra's native loop has no hard iteration cap; `LoopStep.maxIterations` needs a synthetic counter step — flagged gap, not solved here. |
| `suspend` / `approval` | Mastra's native `.suspend()` / resume | Closest fit of any step kind — both are already AIP-7-shaped. |
| `subworkflow` | nested `createWorkflow(...)` as a step | Mastra supports workflow-as-step natively. |
| `agent` | a step whose `execute` calls the SAME `AgentSessionHost` port the daemon already injects | Mastra has no session-lifecycle primitive (sessionRef/sandbox/policy) to map onto — wrap the existing host port rather than force-fitting a native one. |
| `transform` | plain step, `execute: async ({inputData}) => step.compute(...)` | Only reachable via an entry-based handle after this PR's `compile-workflow.ts` passthrough case (see `run-workflow.test.ts` / `compile-workflow.test.ts`). |

**AI SDK direction — much smaller gap than Mastra.** AI SDK (v5/v6, per
`adapters/ai-sdk`'s peerDep) has no first-class step-graph primitive — its
unit is a tool-calling loop (`generateText`/`streamText` with `tools` +
`stopWhen`). `@agentproto/workflow-runtime`'s `runWorkflow` is *already* a
portable, dependency-light async function with no daemon coupling
(`(args: RunWorkflowArgs) => Promise<WorkflowRunResult>`), so the natural
"projection" is closer to a no-op: `toAiSdkWorkflowTool(compiled, opts)`
wraps `(input) => runWorkflow({ workflow: compiled, input }).then(r =>
r.output)` as a single AI SDK `dynamicTool` (whole-workflow-as-one-tool) — no
step-by-step mapping needed, because there's no competing control-flow
engine to reconcile with, unlike Mastra.

**Import direction (Mastra/AI-SDK → WORKFLOW.md), briefly.** From Mastra: a
`Workflow` object exposes its own step graph, so `fromMastraWorkflow(wf):
WorkflowHandle` could walk it and emit an entry.mjs-shaped handle — tool
steps calling back into Mastra's own `step.execute` via a synthetic
`ToolHandle` + driver. Branch/loop semantics differ enough between the two
engines that round-tripping is likely lossy; that's a documented limitation,
not something to solve in the first cut. From AI SDK: there's no step graph
to import, only a single `generateText`+`tools` call — the only sensible
"import" is embedding that whole loop as one `tool`-kind step.

### B. Agentflow (`workflow_start`) → WORKFLOW.md agent-step unification

**What already exists.** `workflow_start`'s per-step schema
(`workflowStepSchema`, `packages/runtime/src/orchestration-tools.ts:747`) —
`label`/`adapter`/`prompt`/`sessionRef`/`cacheable`/`sandbox`/`policy` — is a
near-exact structural subset of AIP-15's `AgentStep`
(`packages/workflow-runtime/src/types.ts`): `label`→`id`, everything else is
a 1:1 field name match. `workflow_start`'s `stages: [{ steps: [...] }]` is
isomorphic to a linear list of top-level `ParallelStep`s, one per stage, each
branch wrapping one `AgentStep`. Both surfaces already run through the same
`runWorkflow` engine (per this PR's framing) — they diverge only in
*authoring* surface: a bespoke MCP-tool JSON shape vs. AIP-15
frontmatter/entry.mjs, both ending at `compileWorkflow` → `runWorkflow`.

**Proposed unification, in three non-breaking phases:**

1. A pure, I/O-free mapping function `stagesToWorkflowHandle(input):
   WorkflowHandle` turning `{ workflowId, stages, ... }` into an entry-shaped
   handle: `stages.map((stage, i) => ({ id: stage.label ?? \`stage_${i}\`,
   kind: "parallel", branches: stage.steps.map(s => ({ id: s.label, steps:
   [{ kind: "agent", id: s.label, adapter: s.adapter, prompt: () =>
   s.prompt, sessionRef: s.sessionRef, sandbox: s.sandbox, policy: s.policy,
   cacheable: s.cacheable }] })) }))` (a single one-step stage can degenerate
   to a bare `agent` step — an optional simplification, not required for
   correctness).
2. Re-implement `workflow_start`'s handler in terms of (1): build the handle,
   then compile + run it through the exact same path `startFromFile` already
   uses, instead of the bespoke stage-barrier executor in
   `workflow-runner.ts`. The MCP tool's request/response JSON stays
   byte-identical — `workflow-mcp-e2e.test.ts`'s existing assertions should
   pass unchanged, since only the internals move. This is the payoff: one
   executor, one compiler, two authoring front-ends instead of two executors.
3. Once (2) ships, `workflow_start`'s tool description can say it's sugar
   over WORKFLOW.md agent-steps, and a `workflow_run_stages` (or similar)
   entry point could skip the JSON→handle→compile round-trip for callers
   that want the mapping without the MCP tool's specific shape.

**Deliberately out of scope for this SPEC:** deprecating/removing
`workflow_start`'s JSON-stage shape — it's a public MCP surface with
existing callers (routine `agent` targets, cron, external integrations);
retiring it needs an explicit human decision, not a unilateral follow-up.
Also out of scope: unifying the *run-tracking* state machine
(`RunState`/`status()`/`cancel()`/escalation in `workflow-runner.ts`) —
step (2) above unifies the COMPILE path only; run/status/cancel/escalation
bookkeeping is separate, larger surface, flagged as a phase-4 follow-up.

## License

MIT — see [LICENSE](./LICENSE).
