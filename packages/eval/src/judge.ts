import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { defineDriver, implementTool, type DriverHandle } from "@agentproto/driver"
import { scoreSchema } from "./score.js"
import { jsonValueSchema, type JsonValue } from "./json.js"
import type { ScorerBinding } from "./run-eval.js"

/**
 * `llmJudge` — a model-backed scorer.
 *
 * Design (locked): a model-backed scorer stays a TOOL, exactly like the
 * deterministic scorers in `scorers.ts`. What differs is where the model
 * lives: the injected {@link JudgeFn} is closed over by the DRIVER (built by
 * {@link makeLlmJudgeDriver}), never threaded through tool input/context. That
 * keeps `eval.llm-judge`'s contract identical in shape to every other scorer
 * tool, so it composes with the existing `bindScorer` / `runEval` in
 * run-eval.ts with ZERO changes there.
 *
 * The judge itself is vendor-neutral: {@link JudgeFn} is just an injected
 * async function. This file has no LLM SDK and no network dependency — a real
 * adapter (an agent session, a supervisor judge-gate, …) is a documented
 * follow-up, not built here.
 */

// ---------------------------------------------------------------------------
// JudgeVerdict — what an injected judge returns
// ---------------------------------------------------------------------------

/** Zod schema for the raw verdict a {@link JudgeFn} produces. */
export const judgeVerdictSchema = z.object({
  /** Normalized judge score in [0, 1]. */
  value: z.number().min(0).max(1),
  /**
   * Explicit pass/fail from the judge. When present it WINS over the
   * threshold comparison — see {@link makeLlmJudgeDriver}.
   */
  passed: z.boolean().optional(),
  /** Human-readable explanation of the verdict. */
  rationale: z.string().optional(),
})

export type JudgeVerdict = z.infer<typeof judgeVerdictSchema>

// ---------------------------------------------------------------------------
// JudgeFn — the injected capability
// ---------------------------------------------------------------------------

/**
 * The seam a real judge satisfies: given the produced `output`, free-form
 * grading `criteria`, and an optional `expected` reference, return a
 * {@link JudgeVerdict}. Callers supply this — a real LLM call, an agent
 * session, or the supervisor's judge-gate all satisfy the same shape.
 * Deliberately no LLM SDK / network types here: keeping this package
 * vendor-neutral is the point.
 */
export type JudgeFn = (args: {
  readonly output: JsonValue
  readonly criteria: string
  readonly expected?: JsonValue
}) => Promise<JudgeVerdict>

// ---------------------------------------------------------------------------
// eval.llm-judge — the TOOL contract
// ---------------------------------------------------------------------------

/** Tool input for `eval.llm-judge`. */
export interface LlmJudgeInput {
  readonly output: JsonValue
  readonly criteria: string
  readonly expected?: JsonValue
}

export const llmJudgeTool = defineTool({
  id: "eval.llm-judge",
  description:
    "Model-backed scorer: hands `output` (plus free-form `criteria` and an " +
    "optional `expected` reference) to an injected judge and normalizes the " +
    "judge's verdict into the shared Score shape. The judge itself lives in " +
    "the driver (see makeLlmJudgeDriver) — this tool contract carries no " +
    "model call of its own.",
  version: "0.1.0",
  inputSchema: z.object({
    output: jsonValueSchema.describe("The produced value to judge."),
    criteria: z.string().describe("Free-form grading criteria/rubric for the judge."),
    expected: jsonValueSchema
      .optional()
      .describe("Optional reference value the judge may compare against."),
  }),
  outputSchema: scoreSchema,
  mutates: [],
  approval: "auto",
  riskLevel: 0,
})

// ---------------------------------------------------------------------------
// makeLlmJudgeDriver — closes over the injected JudgeFn
// ---------------------------------------------------------------------------

/** Clamp a number into [0, 1]. */
function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x))
}

export interface MakeLlmJudgeDriverOptions {
  /** Minimum `value` to count as passed when the judge omits `passed`. Default 0.5. */
  readonly threshold?: number
}

/**
 * Build a DRIVER that implements `eval.llm-judge` by delegating to `judge`.
 * This is the one seam where the injected model-backed capability enters the
 * system — everything downstream (`bindScorer`, `runEval`) stays unaware that
 * this scorer is model-backed at all.
 */
export function makeLlmJudgeDriver(
  judge: JudgeFn,
  opts?: MakeLlmJudgeDriverOptions,
): DriverHandle {
  const threshold = opts?.threshold ?? 0.5
  return defineDriver({
    id: "eval-llm-judge",
    name: "Eval LLM Judge (model-backed)",
    description:
      "Model-backed scorer driver: implements eval.llm-judge by awaiting an " +
      "injected JudgeFn and mapping its verdict to the shared Score shape. " +
      "The judge is supplied by the caller — no LLM SDK or network call here.",
    version: "0.1.0",
    kind: "builtin",
    implements: [{ tool: "eval.llm-judge", version: "0.1.0" }],
    implementations: [
      implementTool(llmJudgeTool, async ({ input }) => {
        const verdict = await judge({
          output: input.output,
          criteria: input.criteria,
          expected: input.expected,
        })
        const value = clamp01(verdict.value)
        const passed = verdict.passed ?? value >= threshold
        return {
          value,
          passed,
          label: "llm-judge",
          ...(verdict.rationale ? { rationale: verdict.rationale } : {}),
        }
      }),
    ],
  })
}

// ---------------------------------------------------------------------------
// llmJudge — convenience ScorerBinding factory
// ---------------------------------------------------------------------------

export interface LlmJudgeBinding<A> {
  /** Label for this binding, e.g. "helpfulness". */
  readonly id: string
  /** The injected judge capability. */
  readonly judge: JudgeFn
  /** Free-form grading criteria/rubric handed to the judge on every call. */
  readonly criteria: string
  /** Minimum value to count as passed when the judge omits `passed`. Default 0.5. */
  readonly threshold?: number
  /** Derive the judge's `output` input from the target's output. */
  readonly mapOutput: (ctx: { output: A; expected?: JsonValue }) => JsonValue
}

/**
 * Convenience: build a {@link ScorerBinding} ready to drop into a suite's
 * `scorers` via `bindScorer` — wires up `eval.llm-judge`, a driver built with
 * {@link makeLlmJudgeDriver}, and the input mapping in one call.
 */
export function llmJudge<A>(binding: LlmJudgeBinding<A>): ScorerBinding<A, LlmJudgeInput> {
  const driver = makeLlmJudgeDriver(binding.judge, { threshold: binding.threshold })
  return {
    id: binding.id,
    tool: llmJudgeTool,
    driver,
    mapInput: (ctx) => ({
      output: binding.mapOutput({ output: ctx.output, expected: ctx.expected }),
      criteria: binding.criteria,
      expected: ctx.expected,
    }),
  }
}
