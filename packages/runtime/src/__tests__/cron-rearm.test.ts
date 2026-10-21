/**
 * Cron re-arm after a session restart.
 *
 * A restart retires the old session row and continues the conversation under
 * a NEW id. A `prompt-session` cron job that named the old id would fail its
 * next tick with "session not found", so the restart re-arms it: the job's
 * target moves to the successor id, in memory AND in the persisted
 * `cron-jobs.json`.
 *
 * Agent-LABEL targets (`action.agent`) are deliberately untouched: they are
 * resolved at FIRE time against whichever live session carries the label, so
 * they survive a restart on their own.
 */

import { describe, it, expect, afterEach } from "vitest"
import { join } from "node:path"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { createCronScheduler } from "../cron-scheduler.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createSessionsRegistry } from "../sessions.js"

function makeDeps(workspace: string) {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({
    sessionEvents,
    persistPath: join(workspace, "sessions.json"),
  })
  return { sessionEvents, registry }
}

describe("cron re-arm on session restart", () => {
  let tmpDirs: string[] = []

  afterEach(() => {
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
    tmpDirs = []
  })

  it("re-points a prompt-session job at the successor session id and persists it", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "cron-rearm-"))
    tmpDirs.push(workspace)
    const persistPath = join(workspace, "cron-jobs.json")
    const deps = makeDeps(workspace)
    const scheduler = createCronScheduler({ ...deps, workspace, persistPath })
    try {
      const job = await scheduler.create({
        schedule: "* * * * *",
        action: { kind: "prompt-session", sessionId: "sess_old", prompt: "status?" },
      })

      const rearmed = scheduler.rearmSessionTarget("sess_old", "sess_new")

      expect(rearmed).toEqual([job.id])
      expect(scheduler.get(job.id)?.action).toEqual({
        kind: "prompt-session",
        sessionId: "sess_new",
        prompt: "status?",
      })

      // Persisted: a fresh scheduler over the same file sees the new target.
      const reloaded = createCronScheduler({ ...deps, workspace, persistPath })
      try {
        expect(reloaded.get(job.id)?.action).toMatchObject({ sessionId: "sess_new" })
      } finally {
        reloaded.shutdown()
      }
    } finally {
      scheduler.shutdown()
    }
  })

  it("leaves jobs that target another session, and agent-label targets, alone", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "cron-rearm-"))
    tmpDirs.push(workspace)
    const scheduler = createCronScheduler({
      ...makeDeps(workspace),
      workspace,
      persistPath: join(workspace, "cron-jobs.json"),
    })
    try {
      const other = await scheduler.create({
        schedule: "* * * * *",
        action: { kind: "prompt-session", sessionId: "sess_other", prompt: "status?" },
      })
      const labelled = await scheduler.create({
        schedule: "* * * * *",
        action: { kind: "prompt-session", agent: "nightly", prompt: "status?" },
      })

      const rearmed = scheduler.rearmSessionTarget("sess_old", "sess_new")

      expect(rearmed).toEqual([])
      expect(scheduler.get(other.id)?.action).toMatchObject({ sessionId: "sess_other" })
      expect(scheduler.get(labelled.id)?.action).toMatchObject({ agent: "nightly" })
    } finally {
      scheduler.shutdown()
    }
  })
})
