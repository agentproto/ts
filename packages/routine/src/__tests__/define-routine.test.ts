import { describe, it, expect } from "vitest"
import { defineRoutine } from "../define-routine.js"
import { formatRoutineIssues, routineFrontmatterSchema } from "../schema.js"
import { parseRoutineManifest } from "../manifest/index.js"

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

  it("accepts target.agent with the canonical harness key", () => {
    const result = routineFrontmatterSchema.safeParse({
      ...base,
      target: { agent: { harness: "claude-code", prompt: "say hi" } },
    })
    expect(result.success).toBe(true)
    expect(result.data?.target).toEqual({ agent: { harness: "claude-code", prompt: "say hi" } })
  })

  it("rejects the pre-rename target.agent.adapter, naming harness", () => {
    const result = routineFrontmatterSchema.safeParse({
      ...base,
      target: { agent: { adapter: "claude-code", prompt: "say hi" } },
    })
    expect(result.success).toBe(false)
    expect(formatRoutineIssues(result.error!.issues)).toContain(
      "target.agent.adapter: `target.agent.adapter` was renamed to `target.agent.harness` (AIP-41); write `harness: <slug>`",
    )
  })

  it("rejects adapter even next to harness", () => {
    const result = routineFrontmatterSchema.safeParse({
      ...base,
      target: { agent: { harness: "hermes", adapter: "hermes", prompt: "say hi" } },
    })
    expect(result.success).toBe(false)
  })

  it("rejects target.agent without harness", () => {
    const result = routineFrontmatterSchema.safeParse({ ...base, target: { agent: { prompt: "say hi" } } })
    expect(result.success).toBe(false)
  })

  it("passes extra agent_start fields on target.agent through (the runtime validates them)", () => {
    const result = routineFrontmatterSchema.safeParse({
      ...base,
      target: {
        agent: { harness: "claude-code", prompt: "say hi", access: { profileRef: "p" }, role: "supervisor" },
      },
    })
    expect(result.success).toBe(true)
    expect(result.data?.target).toEqual({
      agent: { harness: "claude-code", prompt: "say hi", access: { profileRef: "p" }, role: "supervisor" },
    })
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
      target: { agent: { harness: "claude-code" } },
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

// `schedule` was tightened from `z.any()` to a discriminatedUnion("kind", ...)
// alongside `target` — see packages/routine/README.md "Runtime bridge" and
// specs/resources/aip-41/draft/ROUTINE.schema.json's `$defs.schedule*`.
describe("routineFrontmatterSchema — schedule union", () => {
  const base = {
    schema: "routine/v1" as const,
    id: "test-routine",
    description: "test",
    target: { tool: "worktree_gc" },
  }

  it("accepts schedule.kind:cron with just cron (was silently accepted under z.any())", () => {
    const result = routineFrontmatterSchema.safeParse({
      ...base,
      schedule: { kind: "cron", cron: "0 4 * * *" },
    })
    expect(result.success).toBe(true)
  })

  it("accepts schedule.kind:cron with timezone, jitter_seconds, and catchup", () => {
    const result = routineFrontmatterSchema.safeParse({
      ...base,
      schedule: { kind: "cron", cron: "0 4 * * *", timezone: "America/New_York", jitter_seconds: 30, catchup: "one" },
    })
    expect(result.success).toBe(true)
  })

  it("rejects schedule.kind:cron with a cron string too short (min length 9)", () => {
    const result = routineFrontmatterSchema.safeParse({
      ...base,
      schedule: { kind: "cron", cron: "* * *" },
    })
    expect(result.success).toBe(false)
  })

  it("rejects schedule.kind:cron with an invalid catchup enum value", () => {
    const result = routineFrontmatterSchema.safeParse({
      ...base,
      schedule: { kind: "cron", cron: "0 4 * * *", catchup: "always" },
    })
    expect(result.success).toBe(false)
  })

  it("accepts schedule.kind:interval with a valid duration", () => {
    const result = routineFrontmatterSchema.safeParse({
      ...base,
      schedule: { kind: "interval", every: "15m" },
    })
    expect(result.success).toBe(true)
  })

  it("rejects schedule.kind:interval with a malformed duration", () => {
    const result = routineFrontmatterSchema.safeParse({
      ...base,
      schedule: { kind: "interval", every: "fifteen minutes" },
    })
    expect(result.success).toBe(false)
  })

  it("accepts schedule.kind:calendar with an rrule", () => {
    const result = routineFrontmatterSchema.safeParse({
      ...base,
      schedule: { kind: "calendar", rrule: "FREQ=WEEKLY;BYDAY=MO", timezone: "UTC" },
    })
    expect(result.success).toBe(true)
  })

  it("rejects schedule.kind:calendar missing the required rrule", () => {
    const result = routineFrontmatterSchema.safeParse({
      ...base,
      schedule: { kind: "calendar" },
    })
    expect(result.success).toBe(false)
  })

  it("accepts schedule.kind:manual with no other fields", () => {
    const result = routineFrontmatterSchema.safeParse({
      ...base,
      schedule: { kind: "manual" },
    })
    expect(result.success).toBe(true)
  })

  it("accepts schedule.kind:event with an 'on' event name and optional filter", () => {
    const result = routineFrontmatterSchema.safeParse({
      ...base,
      schedule: { kind: "event", on: "session.exited", filter: { adapter: "claude-code" } },
    })
    expect(result.success).toBe(true)
  })

  it("rejects schedule.kind:event missing the required 'on'", () => {
    const result = routineFrontmatterSchema.safeParse({
      ...base,
      schedule: { kind: "event" },
    })
    expect(result.success).toBe(false)
  })

  it("rejects an unrecognized schedule.kind", () => {
    const result = routineFrontmatterSchema.safeParse({
      ...base,
      schedule: { kind: "yearly", cron: "0 0 1 1 *" },
    })
    expect(result.success).toBe(false)
  })

  it("rejects a schedule missing 'kind' entirely (was silently accepted under z.any())", () => {
    const result = routineFrontmatterSchema.safeParse({
      ...base,
      schedule: { cron: "0 4 * * *" },
    })
    expect(result.success).toBe(false)
  })
})

describe("parseRoutineManifest — target.agent harness", () => {
  const manifest = (agentKey: string) =>
    [
      "---",
      "schema: routine/v1",
      "id: nightly",
      "description: test",
      "schedule:",
      "  kind: cron",
      '  cron: "0 4 * * *"',
      "target:",
      "  agent:",
      `    ${agentKey}: claude-code`,
      "    prompt: say hi",
      "---",
      "",
    ].join("\n")

  it("parses a ROUTINE.md with target.agent.harness", () => {
    const parsed = parseRoutineManifest(manifest("harness"))
    expect(parsed.frontmatter.target).toEqual({ agent: { harness: "claude-code", prompt: "say hi" } })
  })

  it("rejects a ROUTINE.md with the pre-rename adapter, naming harness", () => {
    expect(() => parseRoutineManifest(manifest("adapter"))).toThrow(
      /target\.agent\.adapter: `target\.agent\.adapter` was renamed to `target\.agent\.harness` \(AIP-41\)/,
    )
  })
})

describe("defineRoutine — target.agent harness", () => {
  const base = {
    schema: "routine/v1" as const,
    id: "test-routine",
    description: "test",
    schedule: { kind: "cron" as const, cron: "0 4 * * *" },
  }

  it("keeps harness on the handle", () => {
    const handle = defineRoutine({ ...base, target: { agent: { harness: "hermes", prompt: "hi" } } })
    expect(handle.target).toEqual({ agent: { harness: "hermes", prompt: "hi" } })
  })

  it("rejects the pre-rename adapter, naming harness", () => {
    expect(() =>
      defineRoutine({ ...base, target: { agent: { adapter: "hermes", prompt: "hi" } } } as never),
    ).toThrow(/was renamed to `target\.agent\.harness`/)
  })
})
