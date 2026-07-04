/**
 * @agentproto/eval — deterministic reference scorers.
 *
 * A scorer IS an AIP-14 TOOL whose `outputSchema` is the shared {@link Score}
 * shape; there is no separate "scorer port". Each scorer is authored with
 * `defineTool` + `implementTool` and bundled in a single builtin AIP-30
 * PROVIDER, exactly like every other builtin. Invoke one through the driver:
 *
 * ```ts
 * import { runTool } from "@agentproto/driver"
 * import { exactMatchTool, evalScorersProvider } from "@agentproto/eval"
 *
 * const score = await runTool({
 *   tool: exactMatchTool,
 *   candidates: [evalScorersProvider],
 *   input: { actual: "hello", expected: "hello" },
 * })
 * // → { value: 1, passed: true, label: "exact-match", rationale: "…" }
 * ```
 *
 * This pass ships only DETERMINISTIC scorers — no LLM / model calls. An
 * `llm-judge` scorer is a deliberate later step.
 *
 * Spec: https://agentproto.sh/docs/aip-14 (TOOL), /docs/aip-30 (PROVIDER)
 */

import { defineDriver } from "@agentproto/driver"
import {
  exactMatchTool,
  exactMatchImpl,
  regexMatchTool,
  regexMatchImpl,
  jsonSchemaValidTool,
  jsonSchemaValidImpl,
  latencyBudgetTool,
  latencyBudgetImpl,
} from "./scorers.js"

export const SPEC_NAME = "agenteval/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { scoreSchema, type Score } from "./score.js"

export {
  type JsonValue,
  type JsonObject,
  jsonValueSchema,
} from "./json.js"

export {
  exactMatchTool,
  exactMatchImpl,
  regexMatchTool,
  regexMatchImpl,
  jsonSchemaValidTool,
  jsonSchemaValidImpl,
  latencyBudgetTool,
  latencyBudgetImpl,
  type MinimalJsonSchema,
} from "./scorers.js"

export { EVAL_EVENT_SCHEMA, type EvalEvent } from "./events.js"

export {
  runEval,
  bindScorer,
  type EvalCase,
  type ScorerBinding,
  type ScorerInputContext,
  type BoundScorer,
  type EvalSuite,
  type TypedEvalSuite,
  type CaseScore,
  type CaseReport,
  type EvalReport,
  type RunEvalOptions,
} from "./run-eval.js"

export {
  toVitest,
  type VitestHooks,
  type ExpectApi,
  type ToVitestOptions,
} from "./to-vitest.js"

/**
 * Builtin AIP-30 PROVIDER bundling the four deterministic ref scorers.
 * `kind: "builtin"` — pure in-process functions, no subprocess / network hop.
 */
export const evalScorersProvider = defineDriver({
  id: "eval-scorers",
  name: "Eval Reference Scorers (built-in)",
  description:
    "In-process deterministic scorers: exact-match, regex-match, " +
    "json-schema-valid (minimal structural check), and latency-budget. " +
    "Each is an AIP-14 TOOL whose output is the shared Score shape.",
  version: "0.1.0",
  kind: "builtin",
  implements: [
    { tool: "eval.exact-match", version: "0.1.0" },
    { tool: "eval.regex-match", version: "0.1.0" },
    { tool: "eval.json-schema-valid", version: "0.1.0" },
    { tool: "eval.latency-budget", version: "0.1.0" },
  ],
  implementations: [
    exactMatchImpl,
    regexMatchImpl,
    jsonSchemaValidImpl,
    latencyBudgetImpl,
  ],
})
