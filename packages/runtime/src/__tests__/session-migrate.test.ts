import { beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  SessionMigrateError,
  assessMigration,
  isRemoteDelivered,
  migrateSandboxSession,
  restoreSnapshotFor,
  summarizeMigration,
  type SessionMigrateDeps,
} from "../session-migrate.js"
import type { SandboxDeliveryRecord } from "../sandbox-delivery.js"
import type { SessionDescriptor } from "../sessions.js"
import { resolveTurnRetryPolicy } from "../turn-retry-policy.js"
import type { WorkspacesConfig } from "../workspaces-config.js"

vi.mock("../session-spawn.js", async importOriginal => {
  const mod = await importOriginal<typeof import("../session-spawn.js")>()
  return { ...mod, spawnAgentSession: vi.fn() }
})

import { spawnAgentSession } from "../session-spawn.js"

const SHA = "a".repeat(40)

const record = (over: Partial<SandboxDeliveryRecord> = {}): SandboxDeliveryRecord => ({
  at: "2026-10-13T10:00:00.000Z",
  branch: "wt/feat",
  baseSha: "b".repeat(40),
  ahead: 1,
  uncommittedFiles: 2,
  mode: "checkpoint",
  push: { status: "pushed" },
  checkpoint: { status: "pushed", ref: "agentproto-checkpoint/wt/feat", sha: SHA },
  key: "k1",
  bundle: { status: "skipped" },
  ...over,
})

const makePrev = (over: Partial<SessionDescriptor> = {}): SessionDescriptor =>
  ({
    id: "sess_old",
    kind: "agent-cli",
    remote: true,
    workspaceSlug: "repo",
    command: "sandbox:e2b → claude-code",
    pid: 0,
    status: "running",
    startedAt: new Date().toISOString(),
    adapterSlug: "claude-code",
    harness: "claude-code",
    model: "claude-sonnet-5",
    posture: "default",
    contextProfile: "full",
    sandboxId: "box_old",
    sandboxProvider: "e2b",
    sandboxDeliveryTarget: { checkoutDir: "/home/user/repo", branch: "wt/feat", baseSha: "b".repeat(40) },
    sandboxCheckpoint: record(),
    contextContinuity: {
      mode: "auto",
      warnAtPct: 55,
      compactAtPct: 65,
      continueFreshAtPct: 75,
      hardStopAtPct: 90,
      goal: true,
      plan: true,
      decisions: true,
      changedFiles: true,
      gitStatus: true,
      tests: true,
      errors: true,
      risks: true,
      nextStep: true,
      config: true,
      label: "auto",
    },
    ...over,
  }) as SessionDescriptor

const WORKSPACE = { slug: "repo", remote: { url: "https://github.com/acme/repo.git" } }
const workspaces: WorkspacesConfig = {
  workspaces: [{ slug: "repo", path: "/tmp/repo", remote: WORKSPACE.remote }],
} as unknown as WorkspacesConfig

describe("isRemoteDelivered / restoreSnapshotFor", () => {
  it("accepts only a state that reached the remote (a bundle alone is not enough)", () => {
    expect(isRemoteDelivered(record())).toBe(true)
    expect(isRemoteDelivered(record({ unchanged: true, checkpoint: undefined, key: undefined }))).toBe(true)
    expect(isRemoteDelivered(record({ push: { status: "failed" } }))).toBe(false)
    expect(isRemoteDelivered(record({ ahead: 0, push: { status: "skipped" } }))).toBe(true)
    expect(isRemoteDelivered(record({ checkpoint: { status: "failed", ref: "x" } }))).toBe(false)
    expect(isRemoteDelivered(record({ key: undefined }))).toBe(false)
    expect(isRemoteDelivered(record({ push: { status: "failed" }, bundle: { status: "saved", path: "/x.bundle" } }))).toBe(
      false,
    )
  })

  it("pins the pushed snapshot sha, 'none' for a clean checkout, 'any' otherwise", () => {
    expect(restoreSnapshotFor(record())).toEqual({ sha: SHA })
    expect(restoreSnapshotFor(record({ checkpoint: undefined, uncommittedFiles: 0 }))).toBe("none")
    expect(restoreSnapshotFor(record({ checkpoint: undefined, uncommittedFiles: undefined }))).toBe("any")
    expect(restoreSnapshotFor(record({ unchanged: true, checkpoint: undefined }))).toBe("any")
  })
})

describe("assessMigration", () => {
  const code = (r: ReturnType<typeof assessMigration>) => (r.ok ? "ok" : r.error.code)

  it("plans a live sandbox session with its recorded checkpoint", () => {
    const r = assessMigration(makePrev(), WORKSPACE)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan).toMatchObject({ branch: "wt/feat", providerSlug: "e2b", live: true })
    expect(r.plan.recorded?.checkpoint?.sha).toBe(SHA)
  })

  it("refuses a session that is not a sandbox session", () => {
    const r = assessMigration(makePrev({ remote: undefined }), WORKSPACE)
    expect(code(r)).toBe("not_sandbox_session")
    expect(!r.ok && r.error.message).toMatch(/does not run in a sandbox/)
    expect(code(assessMigration(makePrev({ kind: "terminal" } as never), WORKSPACE))).toBe("not_sandbox_session")
  })

  it("refuses device sandboxes", () => {
    expect(code(assessMigration(makePrev({ sandboxProvider: "device:mac" }), WORKSPACE))).toBe("unsupported_sandbox")
    expect(code(assessMigration(makePrev({ hostSessionId: "host_1" }), WORKSPACE))).toBe("unsupported_sandbox")
  })

  it("refuses a box without a work branch", () => {
    expect(code(assessMigration(makePrev({ sandboxDeliveryTarget: undefined }), WORKSPACE))).toBe("no_work_branch")
  })

  it("refuses when the workspace has no remote (or is unknown)", () => {
    const r = assessMigration(makePrev(), { slug: "repo" })
    expect(code(r)).toBe("no_workspace_remote")
    expect(!r.ok && r.error.message).toMatch(/workspace remote set/)
    expect(code(assessMigration(makePrev(), undefined))).toBe("no_workspace_remote")
  })

  it("refuses a dead box with no recorded checkpoint, but allows a live one", () => {
    const base = { sandboxCheckpoint: undefined, sandboxDelivery: undefined }
    expect(code(assessMigration(makePrev({ ...base, status: "exited" }), WORKSPACE))).toBe("no_checkpoint")
    expect(code(assessMigration(makePrev({ ...base, status: "running" }), WORKSPACE))).toBe("ok")
  })

  it("refuses a session without a continuity policy", () => {
    expect(code(assessMigration(makePrev({ contextContinuity: undefined }), WORKSPACE))).toBe("no_context_continuity")
  })

  it("prefers the most recent of the periodic checkpoint and the teardown delivery", () => {
    const newer = record({ at: "2026-10-13T11:00:00.000Z", mode: undefined, checkpoint: undefined, uncommittedFiles: 0 })
    const r = assessMigration(makePrev({ sandboxDelivery: newer }), WORKSPACE)
    expect(r.ok && r.plan.recorded).toBe(newer)
  })
})

describe("migrateSandboxSession", () => {
  let baseDir: string
  let kill: ReturnType<typeof vi.fn>
  let recordSandboxCheckpoint: ReturnType<typeof vi.fn>
  let finalCheckpoint: ReturnType<typeof vi.fn>
  let prevRow: SessionDescriptor

  const deps = (): SessionMigrateDeps =>
    ({
      registry: {
        get: vi.fn(() => prevRow),
        markRetired: vi.fn((id: string, o?: { continuedTo?: string }) => {
          if (o?.continuedTo) prevRow.continuedTo = o.continuedTo
          return prevRow
        }),
        kill,
        recordSandboxCheckpoint,
      },
      resolveAgentAdapter: vi.fn(),
      loadWorkspaces: async () => workspaces,
      loadDefaultsConfig: async () => undefined,
      finalCheckpoint,
    }) as unknown as SessionMigrateDeps

  const spawnOk = () =>
    vi.mocked(spawnAgentSession).mockResolvedValue({
      ok: true,
      descriptor: { id: "sess_new", sandboxId: "box_new", sandboxProvider: "e2b" } as SessionDescriptor,
    })

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "migrate-"))
    prevRow = makePrev()
    kill = vi.fn(() => true)
    recordSandboxCheckpoint = vi.fn()
    finalCheckpoint = vi.fn(async () => record({ at: "2026-10-13T12:00:00.000Z" }))
    vi.mocked(spawnAgentSession).mockReset()
    spawnOk()
    return () => rmSync(baseDir, { recursive: true, force: true })
  })

  it("takes a final checkpoint of the live box, boots a new box on the same branch and kills the old one", async () => {
    const result = await migrateSandboxSession(deps(), prevRow, { baseDir })

    expect(finalCheckpoint).toHaveBeenCalledOnce()
    expect(finalCheckpoint.mock.calls[0]?.[0]).toMatchObject({ branch: "wt/feat" })
    expect(recordSandboxCheckpoint).toHaveBeenCalledWith("sess_old", expect.objectContaining({ key: "k1" }), expect.any(String))

    const [, input] = vi.mocked(spawnAgentSession).mock.calls[0]!
    expect(input).toMatchObject({
      sandbox: "e2b",
      workspaceSlug: "repo",
      worktree: { slug: "feat" },
      adapter: "claude-code",
      model: "claude-sonnet-5",
      sandboxCheckpointRestore: { sha: SHA },
    })
    expect(input.cwd).toBeUndefined()
    expect(input.prompt).toContain("[continued session")
    expect(input.prompt).toContain("Sandbox migrated")
    expect(input.prompt).toContain("agentproto-checkpoint/wt/feat")
    expect(input.turnRetry).toBeUndefined()

    expect(kill).toHaveBeenCalledWith("sess_old", "SIGTERM", "restarted")
    expect(result).toMatchObject({ ok: true, migratedFrom: "sess_old", oldSessionKilled: true })
    expect(result.restore).toMatchObject({ source: "live", snapshot: { sha: SHA }, branch: "wt/feat" })
    expect(prevRow.continuedTo).toBe("sess_new")

    expect(summarizeMigration(result)).toMatchObject({
      migratedFrom: "sess_old",
      migratedTo: "sess_new",
      sandboxId: "box_new",
      branch: "wt/feat",
      restore: { source: "live", snapshot: SHA },
      oldSessionKilled: true,
    })
  })

  it("carries the turnRetry policy onto the migrated session (as a restart does)", async () => {
    prevRow = makePrev({
      turnRetry: resolveTurnRetryPolicy({ on: ["rate-limit", "upstream-5xx"], action: "migrate", maxMigrations: 3 }),
    })
    await migrateSandboxSession(deps(), prevRow, { baseDir })

    const [, input] = vi.mocked(spawnAgentSession).mock.calls[0]!
    expect(input.turnRetry).toEqual(prevRow.turnRetry)
    expect(input.turnRetry).toMatchObject({ on: ["rate-limit", "upstream-5xx"], action: "migrate", maxMigrations: 3 })
  })

  it("falls back to the recorded checkpoint when the old box is dead", async () => {
    finalCheckpoint.mockRejectedValue(new Error("sandbox gone"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const result = await migrateSandboxSession(deps(), prevRow, { baseDir })
    warn.mockRestore()
    expect(result.restore.source).toBe("recorded")
    expect(result.restore.snapshot).toEqual({ sha: SHA })
    expect(vi.mocked(spawnAgentSession).mock.calls[0]![1].sandboxCheckpointRestore).toEqual({ sha: SHA })
  })

  it("does not touch the box of a session that already ended, and does not kill it", async () => {
    prevRow = makePrev({ status: "exited" })
    const result = await migrateSandboxSession(deps(), prevRow, { baseDir })
    expect(finalCheckpoint).not.toHaveBeenCalled()
    expect(result.restore.source).toBe("recorded")
    expect(kill).not.toHaveBeenCalled()
    expect(result.oldSessionKilled).toBe(false)
  })

  it("honours skipFinalCheckpoint", async () => {
    const result = await migrateSandboxSession(deps(), prevRow, { baseDir, skipFinalCheckpoint: true })
    expect(finalCheckpoint).not.toHaveBeenCalled()
    expect(result.restore.source).toBe("recorded")
  })

  it("overrides sandbox provider, model and profile for the new box", async () => {
    await migrateSandboxSession(deps(), prevRow, {
      baseDir,
      sandbox: "daytona",
      model: "claude-opus-5-5",
      access: { profileRef: "work" },
    })
    const [, input] = vi.mocked(spawnAgentSession).mock.calls[0]!
    expect(input).toMatchObject({ sandbox: "daytona", model: "claude-opus-5-5", access: { profileRef: "work" } })
  })

  it("restores 'none' for a clean final checkpoint", async () => {
    finalCheckpoint.mockResolvedValue(record({ checkpoint: undefined, uncommittedFiles: 0 }))
    const result = await migrateSandboxSession(deps(), prevRow, { baseDir })
    expect(result.restore.snapshot).toBe("none")
    expect(vi.mocked(spawnAgentSession).mock.calls[0]![1].sandboxCheckpointRestore).toBe("none")
  })

  it("leaves the old session alone when the new box's spawn is refused", async () => {
    vi.mocked(spawnAgentSession).mockResolvedValue({
      ok: false,
      code: "sandbox_unavailable",
      message: "no quota",
    } as never)
    await expect(migrateSandboxSession(deps(), prevRow, { baseDir })).rejects.toMatchObject({
      name: "ContinueFreshSpawnError",
    })
    expect(kill).not.toHaveBeenCalled()
    expect(prevRow.continuedTo).toBeUndefined()
  })

  it("fails with checkpoint_not_delivered (and spawns nothing) when the push never reached the remote", async () => {
    const bad = record({
      push: { status: "failed", detail: "auth" },
      bundle: { status: "saved", path: "/tmp/x.bundle" },
    })
    finalCheckpoint.mockResolvedValue(bad)
    prevRow = makePrev({ sandboxCheckpoint: bad })
    const err = await migrateSandboxSession(deps(), prevRow, { baseDir }).catch(e => e)
    expect(err).toBeInstanceOf(SessionMigrateError)
    expect(err.code).toBe("checkpoint_not_delivered")
    expect(err.message).toContain("/tmp/x.bundle")
    expect(spawnAgentSession).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  })

  it("uses the recorded checkpoint when the final one cannot be pushed", async () => {
    finalCheckpoint.mockResolvedValue(record({ push: { status: "failed" } }))
    const result = await migrateSandboxSession(deps(), prevRow, { baseDir })
    expect(result.restore.source).toBe("recorded")
  })

  it("fails with no_checkpoint when a live box cannot checkpoint and nothing was recorded", async () => {
    prevRow = makePrev({ sandboxCheckpoint: undefined })
    finalCheckpoint.mockResolvedValue(undefined)
    await expect(migrateSandboxSession(deps(), prevRow, { baseDir })).rejects.toMatchObject({ code: "no_checkpoint" })
    expect(spawnAgentSession).not.toHaveBeenCalled()
  })

  it("surfaces pre-flight errors before any side effect", async () => {
    await expect(
      migrateSandboxSession(deps(), makePrev({ remote: undefined }), { baseDir }),
    ).rejects.toMatchObject({ code: "not_sandbox_session" })
    const noRemote = { ...deps(), loadWorkspaces: async () => ({ workspaces: [{ slug: "repo", path: "/tmp/repo" }] }) as never }
    await expect(migrateSandboxSession(noRemote, prevRow, { baseDir })).rejects.toMatchObject({
      code: "no_workspace_remote",
    })
    expect(finalCheckpoint).not.toHaveBeenCalled()
    expect(spawnAgentSession).not.toHaveBeenCalled()
  })
})
