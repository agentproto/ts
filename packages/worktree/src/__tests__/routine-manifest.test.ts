/**
 * Validates the shipped `routines/worktree-gc/ROUTINE.md` reference manifest
 * against the canonical AIP-41 `routineFrontmatterSchema` (via
 * `parseRoutineManifest`). The manifest is a co-located template for the
 * `worktree_gc` engine in `src/gc.ts`; this test guards it from drifting out
 * of spec — a bad edit fails here rather than at install time in a workspace.
 *
 * `schedule` and `target` are `z.any()` in the top-level schema (the spec
 * keeps the when/what shapes open), so we re-parse just those two with narrow
 * local schemas to assert their contents in a typed way — no casts needed.
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { parseRoutineManifest } from "@agentproto/routine"

const MANIFEST_PATH = fileURLToPath(
  new URL("../../routines/worktree-gc/ROUTINE.md", import.meta.url),
)

const cronScheduleSchema = z.object({
  kind: z.literal("cron"),
  cron: z.string(),
  timezone: z.string(),
  catchup: z.string(),
})

const toolTargetSchema = z.object({
  tool: z.string(),
  inputs: z.object({ apply: z.boolean(), salvageDirty: z.boolean() }),
})

describe("worktree-gc ROUTINE.md", () => {
  const source = readFileSync(MANIFEST_PATH, "utf8")
  const { frontmatter } = parseRoutineManifest(source)

  it("parses and validates against routineFrontmatterSchema", () => {
    // parseRoutineManifest throws on any schema violation, so reaching here
    // already proves validity — assert the load-bearing fields explicitly.
    expect(frontmatter.schema).toBe("routine/v1")
    expect(frontmatter.id).toBe("worktree-gc")
  })

  it("ships opt-in (enabled: false)", () => {
    expect(frontmatter.enabled).toBe(false)
  })

  it("fires worktree_gc daily with apply on, salvage off", () => {
    const schedule = cronScheduleSchema.parse(frontmatter.schedule)
    expect(schedule.cron).toBe("0 4 * * *")
    expect(schedule.timezone).toBe("UTC")
    expect(schedule.catchup).toBe("skip")

    const target = toolTargetSchema.parse(frontmatter.target)
    expect(target.tool).toBe("worktree_gc")
    expect(target.inputs.apply).toBe(true)
    expect(target.inputs.salvageDirty).toBe(false)
  })

  it("routes failures and declares its lifecycle events", () => {
    expect(frontmatter.retry).toEqual({ max_attempts: 1, backoff: "fixed" })
    expect(frontmatter.on_failure).toEqual({
      create_work_item: true,
      fire_event: "worktree.gc.failed",
    })
    expect(frontmatter.fires_events).toEqual([
      "worktree.gc.completed",
      "worktree.gc.failed",
    ])
    expect(frontmatter.tags).toEqual(["worktree", "gc", "maintenance"])
  })
})
