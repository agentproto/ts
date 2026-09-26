import { judgeVerdictSchema, type JudgeVerdict } from "../judge.js"

/**
 * Validate a raw judge return value against {@link judgeVerdictSchema}. An
 * injected `JudgeFn` is caller-supplied and only nominally typed — a
 * misbehaving judge can hand back `NaN`, a missing `value`, or any other
 * malformed shape at runtime. Callers use this to fail the `Score` with a
 * rationale instead of letting a bad verdict propagate as `NaN`/`undefined`
 * downstream.
 */
export function parseVerdict(raw: unknown): JudgeVerdict | null {
  const parsed = judgeVerdictSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
