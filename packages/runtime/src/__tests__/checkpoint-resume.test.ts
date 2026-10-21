/**
 * CRASH RESUME (task 18) - a relaunch puts the crashed session's checkpoint
 * back.
 *
 * The incident this covers: a session crashed in its box four times, the
 * daemon had checkpointed the work every time, and every relaunch started
 * from `main` anyway - the checkpoint ref was named after the WORKTREE, so
 * nothing linked a relaunch to the snapshot that held the work.
 *
 * The tests below walk that chain end to end:
 *   1. the daemon records the checkpoint ref on the session row;
 *   2. a relaunch resolves that ref (explicit id, or label correlation);
 *   3. the restore command puts the crashed session's files back - proved
 *      against a REAL git repo with a REAL snapshot commit and a REAL
 *      simulated crash (the worktree is wiped, exactly like a dead box).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  buildCheckpointRestoreCommand,
  checkpointRefFromRecord,
  latestCheckpointRef,
  planCheckpointResumeRestore,
  resolveResumeSource,
  type SessionCheckpointRef,
} from "../checkpoint-resume.js"
import { planSandboxWorkspace } from "../sandbox-workspace-remote.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike } from "../sessions.js"
import type { SandboxDeliveryRecord } from "../sandbox-delivery.js"

/** The commands the FAKE box received. */
const box = vi.hoisted(() => ({ commands: [] as string[] }))

vi.mock("@agentproto/sandbox", async importOriginal => {
  const actual = await importOriginal<typeof import("@agentproto/sandbox")>()
  const fakeHost: Record<string, unknown> = {
    sandboxId: "sbx_resume",
    start: async () => ({ id: "sess_box", status: "idle", startedAt: "2026-01-01T00:00:00.000Z" }),
    exec: async (opts: { command: string }) => {
      box.commands.push(opts.command)
      const stdout = opts.command.includes("rev-parse --verify") ? `${"e".repeat(40)}\n` : ""
      return { exitCode: 0, stdout, stderr: "", durationMs: 1 }
    },
    stop: async () => {},
    close: async () => {},
  }
  return {
    ...actual,
    createSandboxAgentSessionHost: vi.fn(async () => fakeHost),
  }
})

vi.mock("../sandbox-agent-session-proxy.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../sandbox-agent-session-proxy.js")>()
  return {
    ...actual,
    createSandboxAgentSessionProxy: (() => ({
      send: async () => ({}),
      cancel: async () => {},
      close: async () => {},
    })) as unknown as typeof actual.createSandboxAgentSessionProxy,
  }
})

const wsConfigState = vi.hoisted(() => ({
  value: {
    version: 1,
    workspaces: [
      {
        slug: "agentproto",
        path: "/tmp/agentproto",
        addedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        remote: { url: "https://github.com/acme/agentproto.git" },
      },
    ],
  } as unknown as import("../workspaces-config.js").WorkspacesConfig,
}))
vi.mock("../workspaces-config.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../workspaces-config.js")>()
  return { ...actual, loadWorkspacesConfig: vi.fn(async () => wsConfigState.value) }
})

/** Run a shell command in `cwd`; returns stdout. */
function sh(command: string, cwd: string): string {
  return execFileSync("bash", ["-c", command], { cwd, encoding: "utf8" })
}

/** A checkpoint record whose snapshot reached the remote. */
function checkpointRecord(overrides: Partial<SandboxDeliveryRecord> = {}): SandboxDeliveryRecord {
  return {
    at: "2026-10-20T10:00:00.000Z",
    branch: "wt/abc123",
    baseSha: "a".repeat(40),
    ahead: 2,
    uncommittedFiles: 1,
    mode: "checkpoint",
    push: { status: "pushed" },
    checkpoint: { status: "pushed", ref: "agentproto-checkpoint/wt/abc123", sha: "b".repeat(40) },
    bundle: { status: "skipped" },
    ...overrides,
  }
}

describe("checkpoint resume", () => {
  describe("the session metadata keeps the checkpoint ref", () => {
    it("records the ref of the checkpoint the daemon just created", () => {
      const registry = createSessionsRegistry({ persist: false })
      const agent: AgentSessionLike = {
        sessionId: "acp-crash",
        // eslint-disable-next-line require-yield
        async *send() {},
        async cancel() {},
        async close() {},
      }
      const desc = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: agent,
        adapterSlug: "fake",
      })

      expect(registry.recordSandboxCheckpoint(desc.id, checkpointRecord(), "checkpointed")).toBe(true)

      const stored = registry.get(desc.id)
      expect(stored?.lastCheckpoint).toMatchObject({
        ref: "agentproto-checkpoint/wt/abc123",
        sha: "b".repeat(40),
        branch: "wt/abc123",
        sessionId: desc.id,
      })
      // The link is readable back through the pure helper too (a daemon that
      // restarted re-reads the row, not the in-memory registry).
      expect(latestCheckpointRef(stored)).toMatchObject({ ref: "agentproto-checkpoint/wt/abc123" })
      registry.shutdown()
    })

    it("ignores a checkpoint that never reached the remote", () => {
      expect(
        checkpointRefFromRecord(
          checkpointRecord({ checkpoint: { status: "failed", ref: "agentproto-checkpoint/wt/abc123" } }),
        ),
      ).toBeUndefined()
    })

    it("falls back to the recorded checkpoint of an older row", () => {
      const ref = latestCheckpointRef({ sandboxCheckpoint: checkpointRecord() })
      expect(ref?.ref).toBe("agentproto-checkpoint/wt/abc123")
    })

    it("stamps the task the session works on, so a relaunch can correlate", () => {
      const registry = createSessionsRegistry({ persist: false })
      const agent: AgentSessionLike = {
        sessionId: "acp-task",
        // eslint-disable-next-line require-yield
        async *send() {},
        async cancel() {},
        async close() {},
      }
      const desc = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: agent,
        adapterSlug: "fake",
        taskId: "task-42",
      })
      expect(registry.get(desc.id)?.taskId).toBe("task-42")
      registry.shutdown()
    })
  })

  describe("a relaunch resolves the dead session's checkpoint", () => {
    const dead: { id: string; status: string; label: string; lastCheckpoint: SessionCheckpointRef } = {
      id: "sess_dead",
      status: "killed",
      label: "t18",
      lastCheckpoint: {
        ref: "agentproto-checkpoint/wt/abc123",
        sha: "b".repeat(40),
        at: "2026-10-20T10:00:00.000Z",
      },
    }

    it("follows an explicit session id", () => {
      const found = resolveResumeSource({ sessions: [dead], sessionId: "sess_dead" })
      expect(found?.checkpoint.ref).toBe("agentproto-checkpoint/wt/abc123")
      expect(found?.session.id).toBe("sess_dead")
    })

    it("correlates by label", () => {
      const found = resolveResumeSource({ sessions: [dead], label: "t18" })
      expect(found?.session.id).toBe("sess_dead")
    })

    it("correlates by task id", () => {
      const byTask = { ...dead, taskId: "task-42" }
      const found = resolveResumeSource({ sessions: [byTask], taskId: "task-42" })
      expect(found?.session.id).toBe("sess_dead")
      expect(resolveResumeSource({ sessions: [byTask], taskId: "task-99" })).toBeUndefined()
    })

    it("never resumes a LIVE session", () => {
      const live = { ...dead, status: "running" }
      expect(resolveResumeSource({ sessions: [live], sessionId: "sess_dead" })).toBeUndefined()
      expect(resolveResumeSource({ sessions: [live], label: "t18" })).toBeUndefined()
    })

    it("finds nothing for a session that never checkpointed", () => {
      const bare = { id: "sess_bare", status: "killed", label: "t18" }
      expect(resolveResumeSource({ sessions: [bare], sessionId: "sess_bare" })).toBeUndefined()
    })
  })

  describe("the restore command", () => {
    it("is a git restore --source of the checkpoint ref", () => {
      const command = buildCheckpointRestoreCommand({
        checkoutDir: "/home/user/repo",
        ref: "agentproto-checkpoint/wt/abc123",
      })
      expect(command).toContain("git restore --source=")
      expect(command).toContain("refs/remotes/origin/agentproto-checkpoint/wt/abc123")
    })

    it("restores the work of a crashed session (real git, simulated crash)", () => {
      const dir = mkdtempSync(join(tmpdir(), "checkpoint-resume-"))
      try {
        sh("git init -q . && git config user.email a@b.c && git config user.name t", dir)
        writeFileSync(join(dir, "a.txt"), "v1\n")
        sh("git add -A && git commit -qm init", dir)

        // The agent works: a tracked file changes, a new file appears.
        writeFileSync(join(dir, "a.txt"), "v2\n")
        writeFileSync(join(dir, "b.txt"), "new\n")

        // The daemon checkpoints it: the snapshot commit is built through a
        // throwaway index and parked on the checkpoint ref (the same shape as
        // `sandbox-delivery.ts`'s probe), then force-pushed to the remote -
        // here the remote-tracking ref of the local clone.
        const snap = sh(
          "idx=$(mktemp -u) && { cp \"$(git rev-parse --git-path index)\" \"$idx\" 2>/dev/null || true; } && " +
            'GIT_INDEX_FILE="$idx" git add -A && tree=$(GIT_INDEX_FILE="$idx" git write-tree) && ' +
            'snap=$(git commit-tree "$tree" -p HEAD -m "agentproto checkpoint") && ' +
            "git update-ref refs/remotes/origin/agentproto-checkpoint/wt/abc123 \"$snap\" && echo \"$snap\"",
          dir,
        ).trim()
        expect(snap).toMatch(/^[0-9a-f]{40}$/)

        // THE CRASH: the box dies, the worktree is gone, the branch is back
        // at its base commit.
        sh("git reset -q --hard HEAD && git clean -qfd", dir)
        expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("v1\n")
        expect(existsSync(join(dir, "b.txt"))).toBe(false)

        // THE RELAUNCH: the restore command the runtime builds.
        const command = buildCheckpointRestoreCommand({
          checkoutDir: dir,
          ref: "agentproto-checkpoint/wt/abc123",
          sha: snap,
        })
        const out = sh(command, dir)
        expect(out).toContain("restored checkpoint")

        // The file the crashed session was writing is back, byte for byte.
        expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("v2\n")
        expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("new\n")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("leaves the checkout alone when the checkpoint is not the recorded one", () => {
      const dir = mkdtempSync(join(tmpdir(), "checkpoint-resume-sha-"))
      try {
        sh("git init -q . && git config user.email a@b.c && git config user.name t", dir)
        writeFileSync(join(dir, "a.txt"), "v1\n")
        sh("git add -A && git commit -qm init", dir)
        const snap = sh(
          "idx=$(mktemp -u) && cp \"$(git rev-parse --git-path index)\" \"$idx\" && " +
            'GIT_INDEX_FILE="$idx" git add -A && tree=$(GIT_INDEX_FILE="$idx" git write-tree) && ' +
            'git commit-tree "$tree" -p HEAD -m "agentproto checkpoint"',
          dir,
        ).trim()
        sh(`git update-ref refs/remotes/origin/agentproto-checkpoint/wt/abc123 ${snap}`, dir)

        const command = buildCheckpointRestoreCommand({
          checkoutDir: dir,
          ref: "agentproto-checkpoint/wt/abc123",
          sha: "c".repeat(40),
        })
        const out = sh(command, dir)
        expect(out).toContain("checkpoint not restored")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe("the in-box setup", () => {
    it("restores the recorded ref instead of guessing from the branch", () => {
      const plan = planSandboxWorkspace({
        workspaceSlug: "agentproto",
        remote: { url: "https://github.com/acme/agentproto.git" },
        homeDir: "/home/user",
        mintSlug: () => "abc123",
        checkpointResume: { ref: "agentproto-checkpoint/wt/abc123", sha: "b".repeat(40) },
      })
      const restore = plan.steps.filter(s => s.command.includes("git restore --source="))
      expect(restore).toHaveLength(1)
      expect(restore[0]?.command).toContain("refs/remotes/origin/agentproto-checkpoint/wt/abc123")
      // The branch-derived restore is replaced: both restore the same
      // snapshot, and running them in a row would leave the second one on a
      // dirty tree.
      expect(plan.steps.filter(s => s.label === "restore-checkpoint")).toHaveLength(0)
    })

    it("plans no restore step without a checkpoint", () => {
      expect(planCheckpointResumeRestore({ checkoutDir: "/repo", ref: "" })).toEqual([])
    })
  })

  describe("the relaunch of a crashed session", () => {
    const providerHandle = {
      provider: {
        async connect() {
          throw new Error("not expected")
        },
        async boot() {
          throw new Error("not expected")
        },
      },
      slug: "fake",
      name: "Fake",
      version: "test",
      description: "test double",
      requiresSetup: false,
      capabilities: { networkEgress: false, mounts: false, lifecyclePause: false, readOnly: false },
      // A box with its own filesystem: the workspace plan runs inside it.
      defaultCwd: "/home/user",
      async check() {
        return true
      },
    }

    /** A session that died in its box, with the checkpoint it took. */
    function deadSession(registry: ReturnType<typeof createSessionsRegistry>) {
      const agent: AgentSessionLike = {
        sessionId: "acp_crashed",
        // eslint-disable-next-line require-yield
        async *send() {},
        async cancel() {},
        async close() {},
      }
      const dead = registry.spawnAgent({
        workspaceSlug: "agentproto",
        cwd: "/tmp",
        agentSession: agent,
        adapterSlug: "fake",
        label: "t18",
        taskId: "task-42",
      })
      registry.recordSandboxCheckpoint(dead.id, checkpointRecord(), "checkpointed")
      registry.kill(dead.id, "SIGKILL", "crashed")
      return dead
    }

    /** The relaunch: a new spawn linked to the session that died. */
    async function relaunch(
      registry: ReturnType<typeof createSessionsRegistry>,
      resumeFrom: { sessionId?: string; label?: string; taskId?: string },
    ) {
      const { spawnAgentSession } = await import("../session-spawn.js")
      return spawnAgentSession(
        {
          registry,
          resolveAgentAdapter: async () => null,
          resolveSandboxProvider: async () => providerHandle as never,
        },
        {
          adapter: "fake",
          sandbox: "fake",
          workspaceSlug: "agentproto",
          resumeFrom,
        },
      )
    }

    it("restores the dead session's checkpoint into the new box", async () => {
      box.commands.length = 0
      const registry = createSessionsRegistry({ persist: false })
      const dead = deadSession(registry)

      const result = await relaunch(registry, { sessionId: dead.id })

      expect(result.ok).toBe(true)
      // The box was told to restore THAT checkpoint, by ref.
      const restore = box.commands.filter(c => c.includes("git restore --source="))
      expect(restore).toHaveLength(1)
      expect(restore[0]).toContain("refs/remotes/origin/agentproto-checkpoint/wt/abc123")
      // The dead session's work branch is reused, so its pushed commits come
      // back as commits instead of the base branch.
      expect(box.commands.some(c => c.includes("wt/abc123"))).toBe(true)
      registry.shutdown()
    })

    it("finds the dead session by task id and carries the task on", async () => {
      box.commands.length = 0
      const registry = createSessionsRegistry({ persist: false })
      deadSession(registry)

      const result = await relaunch(registry, { taskId: "task-42" })

      expect(result.ok).toBe(true)
      const restore = box.commands.filter(c => c.includes("git restore --source="))
      expect(restore).toHaveLength(1)
      expect(restore[0]).toContain("refs/remotes/origin/agentproto-checkpoint/wt/abc123")
      // The relaunch keeps the correlation key: the NEXT relaunch can find
      // this session the same way.
      if (result.ok) expect(result.descriptor.taskId).toBe("task-42")
      registry.shutdown()
    })

    it("starts from the base branch when nothing is resumed", async () => {
      box.commands.length = 0
      const registry = createSessionsRegistry({ persist: false })
      deadSession(registry)

      const result = await relaunch(registry, { taskId: "task-unknown" })

      expect(result.ok).toBe(true)
      // No dead session matched: no checkpoint restore at all.
      expect(box.commands.filter(c => c.includes("git restore --source="))).toHaveLength(0)
      registry.shutdown()
    })
  })
})
