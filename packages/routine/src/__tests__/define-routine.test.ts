import { describe, it, expect } from "vitest"
import { defineRoutine } from "../define-routine.js"
import { routineFrontmatterSchema } from "../schema.js"

describe("defineRoutine (AIP-41)", () => {
  // The AIP-41 doctype uses 'id' + 'description' instead of the cross-AIP
  // default 'id' + 'description'. Constructing a valid def needs every
  // required field — author real tests once build()/validate() are
  // filled in. This file exists so vitest sees ≥1 test in the package.
  it("imports cleanly", () => {
    expect(typeof defineRoutine).toBe("function")
  })

  // TODO: spec-41 tests — see @agentproto/operator's test suite as
  // a reference once you wire defaults + cross-field rules.
})

// `target` was tightened from `z.any()` to a real union as part of the
// runtime bridge (see packages/routine/README.md "Runtime bridge" section).
describe("routineFrontmatterSchema — target union", () => {
  const base = {
    schema: "routine/v1" as const,
    id: "test-routine",
    description: "test",
    schedule: { kind: "cron", cron: "0 4 * * *" },
  }

  it("accepts target.tool (the pre-existing shape, e.g. worktree-gc's ROUTINE.md)", () => {
    const result = routineFrontmatterSchema.safeParse({
      ...base,
      target: { tool: "worktree_gc", inputs: { apply: true, salvageDirty: false } },
    })
    expect(result.success).toBe(true)
  })

  it("accepts target.agent (new sugar kind)", () => {
    const result = routineFrontmatterSchema.safeParse({
      ...base,
      target: { agent: { adapter: "claude-code", prompt: "say hi" } },
    })
    expect(result.success).toBe(true)
  })

  it("accepts target.workflow with a file ref", () => {
    const result = routineFrontmatterSchema.safeParse({
      ...base,
      target: { workflow: { file: "WORKFLOW.md" } },
    })
    expect(result.success).toBe(true)
  })

  it("accepts target.action (validated, even though the runtime doesn't dispatch it)", () => {
    const result = routineFrontmatterSchema.safeParse({
      ...base,
      target: { action: "aip39:some-action" },
    })
    expect(result.success).toBe(true)
  })

  it("rejects a target with no recognized key", () => {
    const result = routineFrontmatterSchema.safeParse({
      ...base,
      target: { nonsense: true },
    })
    expect(result.success).toBe(false)
  })

  it("rejects target.agent missing required 'prompt'", () => {
    const result = routineFrontmatterSchema.safeParse({
      ...base,
      target: { agent: { adapter: "claude-code" } },
    })
    expect(result.success).toBe(false)
  })

  it("rejects an unknown key alongside a valid target.tool (.strict())", () => {
    const result = routineFrontmatterSchema.safeParse({
      ...base,
      target: { tool: "worktree_gc", extraneous: true },
    })
    expect(result.success).toBe(false)
  })
})
