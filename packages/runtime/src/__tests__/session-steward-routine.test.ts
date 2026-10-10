/**
 * The shipped `session-steward-hourly` ROUTINE.md parses as an AIP-41
 * routine, targets the session-steward-classify workflow with apply on, and
 * ships DISABLED — installing the app must not start closing sessions.
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseRoutineManifest } from "@agentproto/routine/manifest"

const ROUTINE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "apps",
  "session-steward",
  "routines",
  "session-steward-hourly",
  "ROUTINE.md",
)

describe("session-steward-hourly routine", () => {
  it("parses, runs hourly the classify workflow with apply:true, and is disabled by default", () => {
    const { frontmatter } = parseRoutineManifest(readFileSync(ROUTINE_PATH, "utf8"))
    expect(frontmatter.id).toBe("session-steward-hourly")
    expect(frontmatter.enabled).toBe(false)
    expect(frontmatter.schedule).toMatchObject({ kind: "cron", cron: "0 * * * *" })
    const target = frontmatter.target as { workflow?: { file?: string }; inputs?: Record<string, unknown> }
    expect(target.workflow?.file).toMatch(/session-steward\/\.agentproto\/workflows\/session-steward-classify\/WORKFLOW\.md$/)
    expect(target.inputs).toEqual({
      apply: true,
      history: false,
      userOrigins: ["chat-starter", "vscode"],
    })
  })
})
