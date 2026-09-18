import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { defineDriver, implementTool, type DriverHandle } from "@agentproto/driver"
import { scoreSchema } from "../score.js"
import type { JudgeFn } from "../judge.js"

/**
 * `eval.outline-fidelity` — model-backed scorer: does `answer` cover every
 * point in `outline` without adding unsourced facts. Reuses the existing
 * {@link JudgeFn} seam (`output = answer`, `expected = outline`) — no new
 * judge type. Unlike `eval.llm-judge`, `passed` here is a FIXED gate
 * (`value >= 0.95`, per DESIGN.md §7), never overridden by the judge's own
 * `passed`.
 */

export interface OutlineFidelityInput {
  readonly outline: string
  readonly answer: string
}

export const outlineFidelityTool = defineTool({
  id: "eval.outline-fidelity",
  description:
    "Model-backed scorer: asks an injected judge whether `answer` covers " +
    "every point in `outline` with zero added facts. value = covered/total " +
    "as judged; passed = value >= 0.95, a fixed gate (not the judge's own " +
    "passed). The judge lives in the driver (see makeOutlineFidelityDriver).",
  version: "0.1.0",
  inputSchema: z.object({
    outline: z.string().describe("The source outline — bullet points the answer must cover."),
    answer: z.string().describe("The produced prose answer to check for fidelity."),
  }),
  outputSchema: scoreSchema,
  mutates: [],
  approval: "auto",
  riskLevel: 0,
})

const FIDELITY_THRESHOLD = 0.95

const FIDELITY_CRITERIA =
  "Score how faithfully the answer covers the outline: value = (outline " +
  "points covered) / (total outline points), where any fact in the answer " +
  "not present in the outline counts as a violation and caps value at the " +
  "fraction covered. 1.0 means every outline point is covered and nothing " +
  "was added."

/**
 * Build a DRIVER that implements `eval.outline-fidelity` by delegating to
 * `judge`, the same {@link JudgeFn} shape as `eval.llm-judge`.
 */
export function makeOutlineFidelityDriver(judge: JudgeFn): DriverHandle {
  return defineDriver({
    id: "eval-outline-fidelity",
    name: "Eval Outline Fidelity (model-backed)",
    description:
      "Model-backed scorer driver: implements eval.outline-fidelity by " +
      "awaiting an injected JudgeFn over {answer, outline} and gating on a " +
      "fixed 0.95 threshold, not the judge's own passed.",
    version: "0.1.0",
    kind: "builtin",
    implements: [{ tool: "eval.outline-fidelity", version: "0.1.0" }],
    implementations: [
      implementTool(outlineFidelityTool, async ({ input }) => {
        const verdict = await judge({
          output: input.answer,
          criteria: FIDELITY_CRITERIA,
          expected: input.outline,
        })
        const value = Math.min(1, Math.max(0, verdict.value))
        const passed = value >= FIDELITY_THRESHOLD
        return {
          value,
          passed,
          label: "outline-fidelity",
          ...(verdict.rationale ? { rationale: verdict.rationale } : {}),
        }
      }),
    ],
  })
}
