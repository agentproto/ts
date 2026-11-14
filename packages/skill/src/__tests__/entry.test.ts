import { describe, it, expect, expectTypeOf } from "vitest"
import { defineSkill, type SkillEntry, type SkillHandle } from "../index.js"

describe("SkillEntry", () => {
  it("pairs a skill handle with a mandatory body", () => {
    const skill = defineSkill({ name: "synthetic", description: "A synthetic skill." })
    const entry: SkillEntry = { skill, body: "Do the thing." }
    expectTypeOf(entry.skill).toEqualTypeOf<SkillHandle>()
    expectTypeOf(entry.body).toEqualTypeOf<string>()
    expect(entry.body).toBe("Do the thing.")
    // @ts-expect-error body is mandatory on a SkillEntry
    const missing: SkillEntry = { skill }
    void missing
  })
})
