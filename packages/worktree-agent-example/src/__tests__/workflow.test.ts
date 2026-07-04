/**
 * Integration test: real git-worktree provisioning + real gate-command
 * execution, with a fake AgentSessionHost standing in for the coding agent
 * (no live LLM turn) — the fallback the brief calls out when a genuine
 * end-to-end claude-code run isn't feasible in an automated test.
 */
import { describe, it, expect, vi } from "vitest"
import { mkdtemp, rm, writeFile, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runWorkflow, type AgentSessionHost } from "@agentproto/workflow-runtime"
import { execGit } from "@agentproto/worktree"
import { worktreeAgentWorkflow, type WorktreeAgentInput } from "../workflow.js"

async function makeTempRepo(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "wt-agent-repo-"))
  await execGit(repoRoot, ["init", "-b", "main"])
  await execGit(repoRoot, ["config", "user.email", "test@example.com"])
  await execGit(repoRoot, ["config", "user.name", "Test"])
  await writeFile(join(repoRoot, "check.sh"), "#!/bin/sh\nexit 0\n")
  await execGit(repoRoot, ["add", "."])
  await execGit(repoRoot, ["commit", "-m", "init"])
  return repoRoot
}

function fakeHost(): AgentSessionHost {
  return {
    spawn: vi.fn(async () => "sess_fake"),
    sendPromptAndWait: vi.fn(async () => {}),
    resolveByLabel: vi.fn(() => undefined),
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

describe("worktreeAgentWorkflow (real git + gate, fake agent host)", () => {
  it("gate passes → approves → cleans up (worktree + branch gone)", async () => {
    const repoRoot = await makeTempRepo()
    const host = fakeHost()
    const wfInput: WorktreeAgentInput = {
      repoRoot,
      slug: "e2e-pass",
      base: "main",
      task: "do the thing",
      gateCmd: "exit 0",
    }
    try {
      const { output } = await runWorkflow({
        workflow: worktreeAgentWorkflow,
        input: wfInput,
        agents: host,
      })
      const out = output as { cwd: string; branch: string; gate: { passed: boolean }; cleanup: { removed: boolean } }
      expect(out.gate.passed).toBe(true)
      expect(out.cleanup.removed).toBe(true)
      expect(host.spawn).toHaveBeenCalledWith("claude-code", { cwd: out.cwd, workspaceSlug: undefined, stepId: "code" })
      expect(await exists(out.cwd)).toBe(false)
      const branches = await execGit(repoRoot, ["branch", "--list", out.branch])
      expect(branches.stdout.trim()).toBe("")
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
      await rm(join(repoRoot, "..", "_worktrees", "e2e-pass"), { recursive: true, force: true })
    }
  })

  it("gate fails → skips cleanup, leaves the worktree for inspection", async () => {
    const repoRoot = await makeTempRepo()
    const host = fakeHost()
    const wfInput: WorktreeAgentInput = {
      repoRoot,
      slug: "e2e-fail",
      base: "main",
      task: "do the thing",
      gateCmd: "exit 1",
    }
    try {
      const { output } = await runWorkflow({
        workflow: worktreeAgentWorkflow,
        input: wfInput,
        agents: host,
      })
      const out = output as { cwd: string; gate: { passed: boolean }; cleanup: { removed: boolean; reason: string } }
      expect(out.gate.passed).toBe(false)
      expect(out.cleanup).toEqual({ removed: false, reason: "gate_failed" })
      expect(await exists(out.cwd)).toBe(true)
    } finally {
      await execGit(repoRoot, ["worktree", "remove", "--force", join(repoRoot, "..", "_worktrees", "e2e-fail")]).catch(() => {})
      await rm(repoRoot, { recursive: true, force: true })
      await rm(join(repoRoot, "..", "_worktrees", "e2e-fail"), { recursive: true, force: true })
    }
  })

  it("gate passes but human rejects → skips cleanup", async () => {
    const repoRoot = await makeTempRepo()
    const host = fakeHost()
    const wfInput: WorktreeAgentInput = {
      repoRoot,
      slug: "e2e-reject",
      base: "main",
      task: "do the thing",
      gateCmd: "exit 0",
    }
    try {
      const { output } = await runWorkflow({
        workflow: worktreeAgentWorkflow,
        input: wfInput,
        agents: host,
        approve: () => false,
      })
      const out = output as { cwd: string; cleanup: { removed: boolean; reason: string } }
      expect(out.cleanup).toEqual({ removed: false, reason: "cleanup_rejected" })
      expect(await exists(out.cwd)).toBe(true)
    } finally {
      await execGit(repoRoot, ["worktree", "remove", "--force", join(repoRoot, "..", "_worktrees", "e2e-reject")]).catch(() => {})
      await rm(repoRoot, { recursive: true, force: true })
      await rm(join(repoRoot, "..", "_worktrees", "e2e-reject"), { recursive: true, force: true })
    }
  })
})
