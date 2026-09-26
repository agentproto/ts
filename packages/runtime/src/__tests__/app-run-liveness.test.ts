/**
 * AIP-58 §2 app-run liveness (P3b, F8/F14) — unit coverage for the pure rule
 * (`reconcileAppRunStatus`, shared read-time by `app_status` and write-time
 * by `sweepAppRuns`) and the write-time sweep itself.
 */

import { describe, it, expect } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { reconcileAppRunStatus, sweepAppRuns } from "../app-run-liveness.js"
import { createAppRegistry } from "../app-registry.js"

describe("reconcileAppRunStatus", () => {
  it("running while any session is live, regardless of workflow-run state", () => {
    expect(
      reconcileAppRunStatus({ sessions: [{ status: "running" }], workflowRunStatuses: [] }),
    ).toEqual({ status: "running" })
  })

  it("running while an owned workflow run is still in flight, even with all sessions terminal", () => {
    expect(
      reconcileAppRunStatus({ sessions: [{ status: "exited" }], workflowRunStatuses: ["running"] }),
    ).toEqual({ status: "running" })
  })

  it("succeeded once every session is clean-terminal and every owned workflow run is terminal", () => {
    expect(
      reconcileAppRunStatus({ sessions: [{ status: "exited" }], workflowRunStatuses: ["done"] }),
    ).toEqual({ status: "succeeded" })
  })

  it("failed when any session ended in error", () => {
    expect(
      reconcileAppRunStatus({ sessions: [{ status: "exited" }, { status: "error" }], workflowRunStatuses: [] }),
    ).toEqual({ status: "failed" })
  })

  it("failed when an owned workflow run itself failed", () => {
    expect(
      reconcileAppRunStatus({ sessions: [{ status: "exited" }], workflowRunStatuses: ["failed"] }),
    ).toEqual({ status: "failed" })
  })

  it("failed { errorCode: orphaned } when every session has vanished from the registry entirely (F8/F14 zombie)", () => {
    expect(
      reconcileAppRunStatus({ sessions: [{ status: undefined }, { status: undefined }], workflowRunStatuses: [] }),
    ).toEqual({ status: "failed", errorCode: "orphaned" })
  })

  it("failed with no sessions at all — never a vacuous success", () => {
    expect(reconcileAppRunStatus({ sessions: [], workflowRunStatuses: [] })).toEqual({ status: "failed" })
  })
})

describe("sweepAppRuns", () => {
  function makeAppRegistry(runs: { appRunId: string; status: string; sessions: { sessionId: string }[] }[]) {
    const ended: { appRunId: string; opts: unknown }[] = []
    return {
      registry: {
        listRuns: () => runs,
        endRun: (appRunId: string, opts?: unknown) => {
          ended.push({ appRunId, opts })
          const run = runs.find(r => r.appRunId === appRunId)
          if (run && opts && typeof opts === "object" && "status" in opts) {
            run.status = (opts as { status: string }).status
          }
          return run
        },
      },
      ended,
    }
  }

  it("settles a zombie run (0 live sessions, nothing left owning it) to failed orphaned", () => {
    const runs = [{ appRunId: "apprun_1", status: "running", sessions: [{ sessionId: "sess_gone" }] }]
    const { registry, ended } = makeAppRegistry(runs)

    const { swept } = sweepAppRuns({ appRegistry: registry, registry: { get: () => undefined } })

    expect(swept).toEqual(["apprun_1"])
    expect(ended).toHaveLength(1)
    expect(ended[0]!.opts).toMatchObject({ status: "failed", errorCode: "orphaned" })
    expect(runs[0]!.status).toBe("failed")
  })

  it("leaves a run with a live session alone", () => {
    const runs = [{ appRunId: "apprun_2", status: "running", sessions: [{ sessionId: "sess_live" }] }]
    const { registry, ended } = makeAppRegistry(runs)

    const { swept } = sweepAppRuns({
      appRegistry: registry,
      registry: { get: () => ({ status: "running" }) },
    })

    expect(swept).toEqual([])
    expect(ended).toHaveLength(0)
    expect(runs[0]!.status).toBe("running")
  })

  it("never touches an already-terminal run — no re-sweep, no record deletion", () => {
    const runs = [{ appRunId: "apprun_3", status: "succeeded", sessions: [{ sessionId: "sess_x" }] }]
    const { registry, ended } = makeAppRegistry(runs)

    const { swept } = sweepAppRuns({ appRegistry: registry, registry: { get: () => undefined } })

    expect(swept).toEqual([])
    expect(ended).toHaveLength(0)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe("succeeded")
  })

  it("settles a run whose sessions are all clean-terminal to succeeded once its owned workflow run is also terminal", () => {
    const runs = [{ appRunId: "apprun_4", status: "running", sessions: [{ sessionId: "sess_done" }] }]
    const { registry, ended } = makeAppRegistry(runs)

    const { swept } = sweepAppRuns({
      appRegistry: registry,
      registry: { get: () => ({ status: "exited" }) },
      workflowRuns: [{ appRunId: "apprun_4", status: "done" }],
    })

    expect(swept).toEqual(["apprun_4"])
    expect(ended[0]!.opts).toMatchObject({ status: "succeeded" })
    expect(runs[0]!.status).toBe("succeeded")
  })
})

describe("app registry — legacy run statuses", () => {
  it("maps pre-AIP-58 `ended`/`stopped` records onto `succeeded`/`cancelled` on load", () => {
    const dir = mkdtempSync(join(tmpdir(), "app-run-legacy-"))
    try {
      const persistPath = join(dir, "apps.json")
      const run = (appRunId: string, status: string) => ({
        appRunId,
        appId: "app",
        sessions: [],
        startedAt: new Date().toISOString(),
        status,
      })
      writeFileSync(
        persistPath,
        JSON.stringify({ apps: [], applied: [], runs: [run("r1", "ended"), run("r2", "stopped"), run("r3", "running")] }),
        "utf8",
      )
      const registry = createAppRegistry({ persistPath })
      expect(registry.listRuns().map(r => r.status)).toEqual(["succeeded", "cancelled", "running"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
