/**
 * Validates the shipped `routines/worktree-gc-notify/ROUTINE.md` against the
 * canonical AIP-41 `routineFrontmatterSchema` (via `parseRoutineManifest`),
 * same convention as `routine-manifest.test.ts` for the sibling `worktree-gc`
 * routine. This one exercises the `target.workflow` shape instead of
 * `target.tool` — see `worktree-gc-notify-workflow.test.ts` in
 * `packages/runtime` for the workflow it points at actually running.
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { parseRoutineManifest } from "@agentproto/routine"

const MANIFEST_PATH = fileURLToPath(
  new URL("../../routines/worktree-gc-notify/ROUTINE.md", import.meta.url),
)

const cronScheduleSchema = z.object({
  kind: z.literal("cron"),
  cron: z.string(),
  timezone: z.string(),
  catchup: z.string(),
})

const workflowTargetSchema = z.object({
  workflow: z.object({ file: z.string() }),
})

describe("worktree-gc-notify ROUTINE.md", () => {
  const source = readFileSync(MANIFEST_PATH, "utf8")
  const { frontmatter } = parseRoutineManifest(source)

  it("parses and validates against routineFrontmatterSchema", () => {
    expect(frontmatter.schema).toBe("routine/v1")
    expect(frontmatter.id).toBe("worktree-gc-notify")
  })

  it("ships opt-in (enabled: false)", () => {
    expect(frontmatter.enabled).toBe(false)
  })

  it("fires the worktree-gc-notify WORKFLOW.md daily via target.workflow.file", () => {
    const schedule = cronScheduleSchema.parse(frontmatter.schedule)
    expect(schedule.cron).toBe("0 4 * * *")
    expect(schedule.timezone).toBe("UTC")
    expect(schedule.catchup).toBe("skip")

    const target = workflowTargetSchema.parse(frontmatter.target)
    expect(target.workflow.file).toMatch(/worktree-gc-notify\/WORKFLOW\.md$/)
  })

  it("routes failures and declares its lifecycle events", () => {
    expect(frontmatter.retry).toEqual({ max_attempts: 1, backoff: "fixed" })
    expect(frontmatter.on_failure).toEqual({
      create_work_item: true,
      fire_event: "worktree.gc-notify.failed",
    })
    expect(frontmatter.fires_events).toEqual([
      "worktree.gc-notify.completed",
      "worktree.gc-notify.failed",
    ])
    expect(frontmatter.tags).toEqual(["worktree", "gc", "maintenance", "notify"])
  })
})
