import { describe, it, expect } from "vitest"
import { defineWork } from "../define-work.js"

const base = {
  schema: "work.workspace/v2",
  name: "simone",
  title: "Simone",
  description: "Simone's work items.",
} as const

describe("defineWork (AIP-20)", () => {
  it("imports cleanly", () => {
    expect(typeof defineWork).toBe("function")
  })

  it("builds a handle from the redesigned (view-mode-free) shape", () => {
    const handle = defineWork({
      ...base,
      containment: { maxDepth: 3 },
      coordination: { lockStaleSeconds: 60 },
      statusRollup: {
        enabled: true,
        rules: [{ when: "all-children-terminal", category: "done" }],
      },
      views: [{ id: "open", title: "Open work", layout: "board" }],
    } as never)
    expect(handle.name).toBe("simone")
    expect(handle.containment?.maxDepth).toBe(3)
    expect(handle.statusRollup?.rules?.[0]?.category).toBe("done")
    expect(handle.views).toHaveLength(1)
  })

  it("field-validates the new statusRollup rules", () => {
    expect(() =>
      defineWork({
        ...base,
        statusRollup: {
          enabled: true,
          rules: [{ when: "not-a-predicate", category: "done" }],
        },
      } as never),
    ).toThrow(/statusRollup/)
  })

  // AIP-20 redesign: view mode is gone. `extends` / `appliesTo` are no
  // longer declared fields, so the old cross-field rule
  // (appliesTo non-empty ⇒ extends required) was deleted with them.
  it("no longer enforces the removed appliesTo ⇒ extends rule", () => {
    expect(() =>
      defineWork({ ...base, appliesTo: ["operator-x"] } as never),
    ).not.toThrow(/extends MUST be set/)
  })
})
