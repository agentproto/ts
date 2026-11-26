import { describe, expect, it } from "vitest"
import { ProcessorConfigError, defineObserver, defineTransformer, validateProcessors } from "../processors.js"

const t = (name: string, modifies: string[], extra: object = {}) =>
  defineTransformer({ name, hook: "textOut", modifies, run: c => c, ...extra })

describe("validateProcessors", () => {
  it("accepts distinct facets and an explicit after in order", () => {
    expect(() => validateProcessors([t("a", ["x"]), t("b", ["y"]), t("c", ["x", "y"], { after: ["a", "b"] })])).not.toThrow()
  })

  it("requires the late transformer to list ALL earlier ones sharing a facet", () => {
    const a = t("a", ["x"])
    const b = t("b", ["x"], { after: ["a"] })
    const c = t("c", ["x"], { after: ["b"] })
    expect(() => validateProcessors([a, b, c])).toThrowError(/"a" and "c".*"x"/)
  })

  it("facets are case-sensitive exact strings", () => {
    expect(() => validateProcessors([t("a", ["Text"]), t("b", ["text"])])).not.toThrow()
  })

  it("checks the whole array, including processors of a reserved point", () => {
    const dup = defineObserver({ name: "a", hook: "audioOut", observe() {} })
    expect(() => validateProcessors([t("a", ["x"]), dup])).toThrow(ProcessorConfigError)
  })

  it("rejects a negative or non-finite budget, and an after pointing at another point", () => {
    expect(() => validateProcessors([{ ...t("a", ["x"]), budgetMs: -1 }])).toThrowError(/budgetMs/)
    expect(() => validateProcessors([{ ...t("a", ["x"]), budgetMs: Infinity }])).toThrowError(/budgetMs/)
    const other = defineTransformer({ name: "o", hook: "audioOut", modifies: ["x"], run: f => f })
    expect(() => validateProcessors([other, t("b", ["z"], { after: ["o"] })])).toThrowError(/after/)
  })

  it("reports a stable code and the names", () => {
    try {
      validateProcessors([t("a", ["x"]), t("b", ["x"])])
    } catch (e) {
      expect((e as ProcessorConfigError).code).toBe("conflict")
      expect((e as ProcessorConfigError).names).toEqual(["a", "b"])
      expect((e as ProcessorConfigError).facet).toBe("x")
      return
    }
    throw new Error("expected a conflict")
  })
})
