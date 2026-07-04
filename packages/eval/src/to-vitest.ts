/**
 * `toVitest` — turn an {@link TypedEvalSuite} into vitest test registrations.
 *
 * The vitest primitives (`describe` / `it` / `expect`) are INJECTED by the
 * host's own `import ... from "vitest"`, so THIS source carries no vitest
 * runtime dependency (nothing to bundle, nothing to version-pin). It registers
 * one `it(caseId)` per case that runs the case through {@link runEval} and
 * asserts every scorer passed — the same workflow the harness runs, wired as a
 * CI gate.
 */

import { runEval, type RunEvalOptions, type TypedEvalSuite } from "./run-eval.js"

/** The subset of vitest's `expect` this bridge needs. */
export interface ExpectApi {
  (actual: unknown): {
    toBe(expected: unknown): void
  }
}

/** The subset of vitest's `describe`/`it` this bridge needs. */
export interface VitestHooks {
  describe(name: string, body: () => void): void
  it(name: string, body: () => Promise<void> | void): void
  expect: ExpectApi
}

export type ToVitestOptions<I, A> = RunEvalOptions<I, A>

/**
 * Register `describe(suite.id)` with one `it` per case. Each `it` runs the
 * single-case suite through {@link runEval} and asserts the case passed (all
 * scorers green). Failing scorers surface as a failing vitest assertion.
 */
export function toVitest<I, A>(
  suite: TypedEvalSuite<I, A>,
  opts: ToVitestOptions<I, A>,
  hooks: VitestHooks,
): void {
  const { describe, it, expect } = hooks
  describe(suite.id, () => {
    for (const evalCase of suite.cases) {
      it(evalCase.id, async () => {
        const singleCaseSuite: TypedEvalSuite<I, A> = {
          id: `${suite.id}:${evalCase.id}`,
          cases: [evalCase],
          scorers: suite.scorers,
        }
        const report = await runEval(singleCaseSuite, opts)
        const caseReport = report.cases[0]
        expect(caseReport?.passed).toBe(true)
      })
    }
  })
}
