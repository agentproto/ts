# @agentproto/eval

Deterministic reference scorers for agentproto — shipped as AIP-14 TOOL
contracts plus one builtin AIP-30 PROVIDER.

## A scorer is a tool

There is **no separate "scorer port"**. A scorer is an ordinary AIP-14 tool
authored with `defineTool`, whose `outputSchema` is the shared `Score` shape,
and implemented with `implementTool` bundled in a `defineDriver` — exactly like
every other builtin. That reuse buys the registry, retries, and the
`toMastraTool` / `toAiSdkTool` projections for free.

```ts
export const scoreSchema = z.object({
  value: z.number().min(0).max(1), // normalized score
  passed: z.boolean(),             // clears the scorer's threshold
  label: z.string(),               // scorer id, e.g. "exact-match"
  rationale: z.string().optional(),// human-readable why
})
```

## The four deterministic scorers

All are pure functions of their input — no LLM / model calls. For a
model-backed scorer, see [LLM-as-judge scorer](#llm-as-judge-scorer) below.

| Tool id                  | Input                                        | Behavior |
| ------------------------ | -------------------------------------------- | -------- |
| `eval.exact-match`       | `{ actual, expected, trim? }`                | `value` 1 when equal (after optional trim), else 0. |
| `eval.regex-match`       | `{ actual, pattern, flags? }`                | 1 when the compiled RegExp matches, else 0. An **invalid pattern** returns a typed failure `Score` (`value 0`, `rationale: "invalid pattern: …"`) — it never throws. |
| `eval.json-schema-valid` | `{ actual, schema }`                         | Minimal structural check of top-level `required` + `properties.type` only. 1 when valid, else 0 with the first violation in `rationale`. |
| `eval.latency-budget`    | `{ durationMs, budgetMs }`                   | `passed = durationMs <= budgetMs`; `value` is 1 within budget, else `max(0, 1 - (durationMs - budgetMs) / budgetMs)`. |

### `eval.json-schema-valid` limitation

To keep this package light (no `ajv`), the schema check is intentionally
minimal: it verifies the top-level `type`, that every name in `required` is
present, and that any `properties.<name>.type` matches the value's primitive
type. It does **not** recurse into nested schemas, and does not implement the
rest of JSON Schema (`enum`, `format`, `oneOf`, `items`, …). A fuller
validator is a later step.

## Running a scorer

Invoke any scorer through the driver's `runTool`, passing the provider as the
sole candidate:

```ts
import { runTool } from "@agentproto/driver"
import { exactMatchTool, evalScorersProvider } from "@agentproto/eval"

const score = await runTool({
  tool: exactMatchTool,
  candidates: [evalScorersProvider],
  input: { actual: "hello", expected: "hello" },
})
// → { value: 1, passed: true, label: "exact-match", rationale: "actual equals expected" }
```

## Running a suite

An **eval is a workflow**: for each case it runs a `target`, then scores the
target's output with one scorer `tool` step per binding, aggregates, and reports
through the `@agentproto/telemetry` port. `runEval` composes a
`@agentproto/workflow-runtime` `RuntimeWorkflow` per case — the target's
structured output is the input selector for every scorer step — and rolls the
per-case results up into an `EvalReport`.

Each scorer is authored as a `ScorerBinding` (its `tool`, its `driver`, and a
`mapInput` that shapes the target output into the scorer's input) and boxed with
`bindScorer` so scorers with different input types coexist in one suite.

```ts
import { arrayTelemetry } from "@agentproto/telemetry"
import {
  runEval,
  bindScorer,
  exactMatchTool,
  latencyBudgetTool,
  evalScorersProvider,
  type EvalEvent,
  type TypedEvalSuite,
} from "@agentproto/eval"

interface Answer { text: string; latencyMs: number }

const suite: TypedEvalSuite<{ prompt: string }, Answer> = {
  id: "greeting-suite",
  cases: [
    { id: "hello", input: { prompt: "hi" }, expected: "hello" },
    { id: "world", input: { prompt: "wo" }, expected: "world" },
  ],
  scorers: [
    bindScorer<Answer, { actual: string; expected: string }>({
      id: "exact",
      tool: exactMatchTool,
      driver: evalScorersProvider,
      mapInput: ({ output, expected }) => ({
        actual: output.text,
        expected: typeof expected === "string" ? expected : "",
      }),
    }),
    bindScorer<Answer, { durationMs: number; budgetMs: number }>({
      id: "latency",
      tool: latencyBudgetTool,
      driver: evalScorersProvider,
      mapInput: ({ output }) => ({ durationMs: output.latencyMs, budgetMs: 100 }),
    }),
  ],
}

const telemetry = arrayTelemetry<EvalEvent>()
const report = await runEval(suite, {
  target: async ({ prompt }) => ({ text: prompt === "hi" ? "hello" : "world", latencyMs: 10 }),
  telemetry,
})
// report.passedCount / report.meanValue aggregate across cases;
// telemetry.events runs eval.started … eval.finished in order.
```

The `target` is a plain async function (not required to be a tool); a
tool/agent target is a documented follow-up. Events ride the shared telemetry
port — `Telemetry<EvalEvent>` — under the `agentproto/eval/v1` schema
(`eval.started`, `eval.case.started`, `eval.case.scored`, `eval.case.finished`,
`eval.finished`). Sinks MUST tolerate unknown kinds (forward-compat).

## LLM-as-judge scorer

`eval.llm-judge` is a **model-backed** scorer — but it stays a TOOL, exactly
like the four deterministic scorers above. What differs is where the model
lives: the injected judge is closed over by the **driver**, not threaded
through tool input/context, via `makeLlmJudgeDriver(judge)`. That means it
composes with the existing `bindScorer` / `runEval` with zero changes to
either.

The judge itself is an injected function — `JudgeFn` — so this package stays
vendor-neutral: no LLM SDK, no network dependency here.

```ts
export type JudgeFn = (args: {
  output: JsonValue
  criteria: string
  expected?: JsonValue
}) => Promise<JudgeVerdict>
// JudgeVerdict = { value: number (0..1); passed?: boolean; rationale?: string }
```

Build a driver around a judge, then either call the tool directly or use the
`llmJudge(...)` convenience to get a ready-to-use `ScorerBinding`:

```ts
import { runTool } from "@agentproto/driver"
import {
  llmJudgeTool,
  makeLlmJudgeDriver,
  llmJudge,
  bindScorer,
  type JudgeFn,
} from "@agentproto/eval"

// A real judge is injected by the caller — an LLM call, an agent session,
// or the supervisor's judge-gate. Shown here as a stand-in.
const judge: JudgeFn = async ({ output, criteria }) => {
  // ... call out to a model, or whatever satisfies JudgeFn ...
  return { value: 0.9, rationale: "meets the criteria" }
}

// Direct tool invocation:
const score = await runTool({
  tool: llmJudgeTool,
  candidates: [makeLlmJudgeDriver(judge, { threshold: 0.7 })],
  input: { output: "the produced answer", criteria: "Is the answer helpful?" },
})

// Or as a suite scorer:
const binding = bindScorer(
  llmJudge<Answer>({
    id: "helpfulness",
    judge,
    criteria: "Is the answer helpful and correct?",
    threshold: 0.7,
    mapOutput: ({ output }) => output.text,
  }),
)
```

`passed` resolution: when the judge's verdict includes an explicit `passed`,
it **wins** over the threshold comparison — a judge that says `passed: false`
is never overridden by a high `value`, and vice versa. Otherwise `passed =
value >= threshold` (`threshold` defaults to `0.5`).

A real adapter wiring `JudgeFn` up to an agent session or the supervisor's
judge-gate is a documented follow-up — not built in this package.

## As a CI gate

`toVitest` turns a suite into vitest test registrations — one `it(caseId)` per
case that runs the case and asserts every scorer passed. Vitest's own
`describe` / `it` / `expect` are **injected**, so this package carries no vitest
runtime dependency:

```ts
import { describe, it, expect } from "vitest"
import { toVitest } from "@agentproto/eval"

toVitest(
  suite,
  { target: async ({ prompt }) => ({ text: prompt === "hi" ? "hello" : "world", latencyMs: 10 }) },
  { describe, it, expect },
)
```

## Exports

- `runEval`, `bindScorer` — the eval harness (`EvalCase`, `ScorerBinding`,
  `BoundScorer`, `EvalSuite`, `TypedEvalSuite`, `EvalReport`, `CaseReport`,
  `CaseScore`, `RunEvalOptions`)
- `EVAL_EVENT_SCHEMA`, `EvalEvent` — the telemetry-port event union
- `toVitest` — the CI-gate bridge (`VitestHooks`, `ExpectApi`, `ToVitestOptions`)
- `JsonValue`, `JsonObject`, `jsonValueSchema` — the canonical JSON model
- `scoreSchema`, `Score`
- `exactMatchTool` / `exactMatchImpl`
- `regexMatchTool` / `regexMatchImpl`
- `jsonSchemaValidTool` / `jsonSchemaValidImpl` (`MinimalJsonSchema`)
- `latencyBudgetTool` / `latencyBudgetImpl`
- `evalScorersProvider` — the builtin PROVIDER bundling all four
- `llmJudgeTool` — the `eval.llm-judge` TOOL contract
- `makeLlmJudgeDriver` — build a DRIVER that closes over an injected `JudgeFn`
- `llmJudge` — convenience: build a ready-to-use `ScorerBinding` around a judge
- `JudgeFn`, `JudgeVerdict`, `judgeVerdictSchema`, `LlmJudgeInput`,
  `MakeLlmJudgeDriverOptions`, `LlmJudgeBinding`

## License

MIT
