import { describe, it, expect } from "vitest"
import { defineLesson } from "../define-lesson.js"
import type { LessonDefinition } from "../types.js"

const MINIMAL: LessonDefinition = {
  schema: "learning/v1",
  slug: "validate-source-before-recommend",
  title: "Validate the source before recommending a paper.",
  trigger: {
    description: "Recommendation involves a peer-reviewed publication.",
  },
  outcome: "success",
  evidence: [{ kind: "run", ref: "run:42" }],
}

describe("defineLesson (AIP-11) — basic shape", () => {
  it("accepts a minimal valid lesson", () => {
    const lesson = defineLesson(MINIMAL)
    expect(lesson.slug).toBe("validate-source-before-recommend")
    expect(lesson.title).toContain("Validate the source")
    expect(Object.isFrozen(lesson)).toBe(true)
  })
})

describe("defineLesson — schema-derived field validation runs in TS path", () => {
  it("rejects missing required field (schema)", () => {
    expect(() =>
      defineLesson({ ...MINIMAL, schema: undefined as never }),
    ).toThrow(/defineLesson \(AIP-11\)/)
  })

  it("rejects invalid slug (uppercase)", () => {
    expect(() => defineLesson({ ...MINIMAL, slug: "BadCaps" })).toThrow(
      /invalid id 'BadCaps'/,
    )
  })

  it("rejects invalid outcome (must be enum)", () => {
    expect(() =>
      defineLesson({
        ...MINIMAL,
        outcome: "kind-of-worked" as never,
      }),
    ).toThrow(/defineLesson \(AIP-11\)/)
  })

  it("rejects empty evidence array (schema requires ≥1)", () => {
    // The schema's minItems=1 narrows TS to a non-empty tuple type;
    // the `as never` runs the runtime check to prove the zod still
    // catches a hand-bypassed empty array.
    expect(() =>
      defineLesson({ ...MINIMAL, evidence: [] as never }),
    ).toThrow(/defineLesson \(AIP-11\)/)
  })

  it("rejects oversized title (schema cap: 200 chars)", () => {
    expect(() =>
      defineLesson({ ...MINIMAL, title: "x".repeat(201) }),
    ).toThrow(/defineLesson \(AIP-11\)/)
  })
})
