import { describe, expect, it } from "vitest"
import { shouldDebit } from "../index.js"

describe("shouldDebit truth table", () => {
  const m = "claude-opus-4-5"

  it("BYOK active + connector → shadow, no debit", () => {
    expect(shouldDebit({ modelId: m, byokActive: true, hasConnector: true })).toEqual(
      { debit: false, shadow: true, reason: "byok-active-with-connector" },
    )
  })

  it("BYOK active + no connector → debit (fall back to credits)", () => {
    expect(
      shouldDebit({ modelId: m, byokActive: true, hasConnector: false }),
    ).toEqual({ debit: true, shadow: false, reason: "byok-flag-but-no-connector" })
  })

  it("non-BYOK + connector → debit", () => {
    expect(
      shouldDebit({ modelId: m, byokActive: false, hasConnector: true }),
    ).toEqual({ debit: true, shadow: false, reason: "non-byok" })
  })

  it("non-BYOK + no connector → debit", () => {
    expect(
      shouldDebit({ modelId: m, byokActive: false, hasConnector: false }),
    ).toEqual({ debit: true, shadow: false, reason: "non-byok" })
  })
})
