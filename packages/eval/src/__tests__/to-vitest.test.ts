import { describe, expect, it } from "vitest"
import {
  toVitest,
  bindScorer,
  evalScorersProvider,
  exactMatchTool,
  type TypedEvalSuite,
} from "../index.js"

interface Answer {
  readonly text: string
}

/** Suite with one passing and one failing case, scored by exact-match. */
const suite: TypedEvalSuite<{ prompt: string }, Answer> = {
  id: "to-vitest-suite",
  cases: [
    { id: "passes", input: { prompt: "p" }, expected: "match" },
    { id: "fails", input: { prompt: "f" }, expected: "match" },
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
  ],
}

async function target(input: { prompt: string }): Promise<Answer> {
  return input.prompt === "p" ? { text: "match" } : { text: "nope" }
}

// The "passes" case is registered as a real passing test via toVitest.
// The "fails" case would fail its assertion, so we register the suite through
// a captured-hooks harness to assert exactly one case passes and one fails,
// WITHOUT letting the failing case fail this file.
describe("toVitest — passing case runs as a real vitest test", () => {
  // Register only the passing case as a live vitest `it`.
  toVitest(
    { ...suite, cases: [suite.cases[0]!] },
    { target },
    { describe, it, expect },
  )
})

describe("toVitest — captured hooks exercise pass + fail", () => {
  it("registers one it per case and each asserts case passed", async () => {
    const registered: { name: string; body: () => Promise<void> | void }[] = []
    let describeName = ""

    const results: { name: string; ok: boolean }[] = []
    const captureExpect = (actual: unknown): { toBe(expected: unknown): void } => ({
      toBe(expected: unknown) {
        if (actual !== expected) {
          throw new Error(`expected ${String(actual)} to be ${String(expected)}`)
        }
      },
    })

    toVitest(
      suite,
      { target },
      {
        describe: (name, body) => {
          describeName = name
          body()
        },
        it: (name, body) => registered.push({ name, body }),
        expect: captureExpect,
      },
    )

    expect(describeName).toBe("to-vitest-suite")
    expect(registered.map((r) => r.name)).toEqual(["passes", "fails"])

    for (const r of registered) {
      try {
        await r.body()
        results.push({ name: r.name, ok: true })
      } catch {
        results.push({ name: r.name, ok: false })
      }
    }

    expect(results).toEqual([
      { name: "passes", ok: true },
      { name: "fails", ok: false },
    ])
  })
})
