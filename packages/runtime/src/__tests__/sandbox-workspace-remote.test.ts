/**
 * Sandbox checkout of a workspace `remote`: the generated setup commands and
 * the runner that executes them through an `exec` seam. Hermetic — `exec` is a
 * fake, nothing here shells out or touches a network. The token is a fake value
 * that must never appear in any command.
 */

import { describe, it, expect } from "vitest"
import type { SandboxExecOpts, SandboxExecResult } from "@agentproto/sandbox"

import {
  GH_TOKEN_ENV,
  GIT_TOKEN_ENV,
  withGhTokenAlias,
  planSandboxWorkspace,
  restoreCheckpointSteps,
  runSandboxWorkspaceSetup,
  buildLearnBranchCommand,
  parseLearnedWorkBranch,
  learnWorkBranch,
  shellQuote,
  withoutReservedSandboxEnv,
  type SandboxWorkspaceRequest,
} from "../sandbox-workspace-remote.js"

const FAKE_TOKEN = "ghp_fake_setup_token_0003"
const BASE_SHA = "a".repeat(40)

const request: SandboxWorkspaceRequest = {
  workspaceSlug: "agentproto",
  remote: { url: "https://github.com/acme/agentproto.git", credentialRef: "agentproto.git.agentproto" },
  homeDir: "/home/user",
  mintSlug: () => "minted01",
}

function ok(stdout = ""): SandboxExecResult {
  return { exitCode: 0, stdout, stderr: "", durationMs: 1 }
}

describe("planSandboxWorkspace", () => {
  it("mints a default wt/<slug> work branch when no worktree is given", () => {
    const plan = planSandboxWorkspace(request)
    expect(plan.checkoutDir).toBe("/home/user/agentproto")
    expect(plan.branch).toBe("wt/minted01")
    expect(plan.baseRef).toBe("origin/main")
    const checkout = plan.steps.find(s => s.label === "git-checkout")?.command ?? ""
    expect(checkout).toContain("git checkout -b 'wt/minted01' 'origin/main'")
  })

  it("clones into <home>/<slug> and checks out the default branch when worktree is false", () => {
    const plan = planSandboxWorkspace({ ...request, worktree: false })
    expect(plan.checkoutDir).toBe("/home/user/agentproto")
    expect(plan.branch).toBeUndefined()
    expect(plan.baseRef).toBe("origin/main")
    const checkout = plan.steps.find(s => s.label === "git-checkout")
    expect(checkout?.command).toBe("git -C '/home/user/agentproto' checkout 'main'")
  })

  it("cuts wt/<slug> from the requested base, reusing the branch if it already exists", () => {
    const plan = planSandboxWorkspace({ ...request, worktree: { slug: "x", base: "origin/develop" } })
    expect(plan.branch).toBe("wt/x")
    expect(plan.baseRef).toBe("origin/develop")
    const checkout = plan.steps.find(s => s.label === "git-checkout")?.command ?? ""
    expect(checkout).toContain("git show-ref --verify --quiet 'refs/heads/wt/x'")
    expect(checkout).toContain("git checkout 'wt/x'")
    expect(checkout).toContain("git checkout -b 'wt/x' 'origin/develop'")
  })

  it("resumes a branch a previous box pushed, then restores its checkpoint snapshot onto the exact commit", () => {
    const plan = planSandboxWorkspace({ ...request, worktree: { slug: "x" } })
    const checkout = plan.steps.find(s => s.label === "git-checkout")?.command ?? ""
    expect(checkout).toContain("git show-ref --verify --quiet 'refs/remotes/origin/wt/x'")
    expect(checkout).toContain("git checkout -b 'wt/x' --track 'origin/wt/x'")
    // local branch first, then the pushed one, then a fresh cut
    expect(checkout.indexOf("refs/heads/wt/x")).toBeLessThan(checkout.indexOf("refs/remotes/origin/wt/x"))
    expect(checkout.indexOf("refs/remotes/origin/wt/x")).toBeLessThan(checkout.indexOf("git checkout -b 'wt/x' 'origin/"))
    const labels = plan.steps.map(s => s.label)
    expect(labels.indexOf("restore-checkpoint")).toBe(labels.indexOf("git-checkout") + 1)
    const restore = plan.steps.find(s => s.label === "restore-checkpoint")?.command ?? ""
    expect(restore).toContain("'refs/remotes/origin/agentproto-checkpoint/wt/x'^")
    expect(restore).toContain('= "$(git rev-parse HEAD)"')
    expect(restore).toContain("git read-tree -u --reset")
    expect(restore).toContain('|| echo "checkpoint not restored"')
  })

  it("reads the checkpoint snapshot back from a custom checkpointRefPrefix", () => {
    const plan = planSandboxWorkspace({ ...request, worktree: { slug: "x" }, checkpointRefPrefix: "safety/" })
    const restore = plan.steps.find(s => s.label === "restore-checkpoint")?.command ?? ""
    expect(restore).toContain("'refs/remotes/origin/safety/wt/x'^")
    expect(restore).not.toContain("agentproto-checkpoint/")
  })

  it("plans no checkpoint restore without a work branch (worktree: false)", () => {
    const plan = planSandboxWorkspace({ ...request, worktree: false })
    expect(plan.steps.some(s => s.label === "restore-checkpoint")).toBe(false)
  })

  it("defaults the base to origin/<defaultBranch> and mints a slug when none is given", () => {
    const plan = planSandboxWorkspace({
      ...request,
      remote: { ...request.remote, defaultBranch: "trunk" },
      worktree: {},
    })
    expect(plan.branch).toBe("wt/minted01")
    expect(plan.baseRef).toBe("origin/trunk")
  })

  it("clone is idempotent: fetch when the checkout exists, clone otherwise", () => {
    const clone = planSandboxWorkspace(request).steps.find(s => s.label === "git-clone")?.command ?? ""
    expect(clone).toContain("if [ -d '/home/user/agentproto/.git' ]")
    expect(clone).toContain("fetch --prune origin")
    expect(clone).toContain("git clone -- 'https://github.com/acme/agentproto.git' '/home/user/agentproto'")
  })

  it("never puts a token in a command: the credential helper reads the env var by name", () => {
    const plan = planSandboxWorkspace({ ...request, worktree: { slug: "x" } })
    const all = plan.steps.map(s => s.command).join("\n")
    expect(all).not.toContain(FAKE_TOKEN)
    expect(all).not.toMatch(/https:\/\/[^/\s'@]*@/)
    const helper = plan.steps.find(s => s.label === "git-credential-helper")?.command ?? ""
    expect(helper).toContain("'credential.https://github.com.helper'")
    expect(helper).toContain(`$${GIT_TOKEN_ENV}`)
    expect(plan.authenticated).toBe(true)
  })

  it("an anonymous remote configures no credential helper", () => {
    const plan = planSandboxWorkspace({ ...request, remote: { url: request.remote.url } })
    expect(plan.authenticated).toBe(false)
    expect(plan.steps.map(s => s.label)).not.toContain("git-credential-helper")
  })

  it("rejects shell metacharacters in the worktree slug, base, and workspace slug", () => {
    expect(() => planSandboxWorkspace({ ...request, worktree: { slug: "x; rm -rf /" } })).toThrow()
    expect(() => planSandboxWorkspace({ ...request, worktree: { slug: "a/b" } })).toThrow()
    expect(() => planSandboxWorkspace({ ...request, worktree: { slug: "x", base: "main$(id)" } })).toThrow()
    expect(() => planSandboxWorkspace({ ...request, workspaceSlug: "../escape" })).toThrow()
  })
})

describe("restoreCheckpointSteps", () => {
  const base = { checkoutDir: "/home/user/agentproto", branch: "wt/x" }
  const CK = "'refs/remotes/origin/agentproto-checkpoint/wt/x'"

  it("plans one non-fatal restore-checkpoint step reading the default checkpoint namespace", () => {
    const steps = restoreCheckpointSteps(base)
    expect(steps).toHaveLength(1)
    const [step] = steps
    expect(step?.label).toBe("restore-checkpoint")
    expect(step?.command.startsWith("cd '/home/user/agentproto' && ")).toBe(true)
    expect(step?.command).toContain(`git show-ref --verify --quiet ${CK}`)
    expect(step?.command).toContain(`git read-tree -u --reset ${CK} && git reset -q`)
    expect(step?.command).toContain('|| echo "checkpoint not restored"')
    expect(step?.command).not.toContain(`[ "$(git rev-parse ${CK})" = '`)
  })

  it("restores onto a clean tree only, and fast-forwards a branch tip the old box never pushed", () => {
    const cmd = restoreCheckpointSteps(base)[0]?.command ?? ""
    expect(cmd).toContain('[ -z "$(git status --porcelain)" ]')
    expect(cmd).toContain(`git merge-base --is-ancestor HEAD ${CK}^ && git merge --ff-only -q ${CK}^`)
  })

  it("pins the exact snapshot commit when one is given", () => {
    const sha = "b".repeat(40)
    const cmd = restoreCheckpointSteps({ ...base, snapshot: { sha } })[0]?.command ?? ""
    expect(cmd).toContain(`[ "$(git rev-parse ${CK})" = '${sha}' ]`)
    expect(restoreCheckpointSteps(base)[0]?.command).not.toContain(sha)
  })

  it('plans nothing for snapshot "none" (a clean last checkpoint must not resurrect a stale snapshot)', () => {
    expect(restoreCheckpointSteps({ ...base, snapshot: "none" })).toEqual([])
  })

  it("honours a custom refPrefix and rejects a snapshot that is not a commit id", () => {
    const cmd = restoreCheckpointSteps({ ...base, refPrefix: "safety/" })[0]?.command ?? ""
    expect(cmd).toContain("'refs/remotes/origin/safety/wt/x'")
    expect(() => restoreCheckpointSteps({ ...base, snapshot: { sha: "x; rm -rf /" } })).toThrow(/not a commit id/)
  })

  it("is what planSandboxWorkspace embeds, and snapshot none drops it from the plan", () => {
    const withWt = { ...request, worktree: { slug: "x" } }
    const embedded = planSandboxWorkspace(withWt).steps.find(s => s.label === "restore-checkpoint")
    expect(embedded?.command).toBe(
      restoreCheckpointSteps({ checkoutDir: "/home/user/agentproto", branch: "wt/x" })[0]?.command,
    )
    expect(
      planSandboxWorkspace({ ...withWt, checkpointSnapshot: "none" }).steps.some(s => s.label === "restore-checkpoint"),
    ).toBe(false)
  })
})

describe("shellQuote", () => {
  it("neutralises single quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
  })
})

describe("runSandboxWorkspaceSetup", () => {
  const plan = planSandboxWorkspace({ ...request, worktree: { slug: "x" } })

  it("runs every step in order from the box home with git prompts disabled and returns the base sha", async () => {
    const calls: SandboxExecOpts[] = []
    const result = await runSandboxWorkspaceSetup(async opts => {
      calls.push(opts)
      return ok(opts.command.includes("rev-parse") ? `${BASE_SHA}\n` : "")
    }, plan)
    expect(result).toEqual({ ok: true, baseSha: BASE_SHA })
    expect(calls.map(c => c.command)).toEqual(plan.steps.map(s => s.command))
    for (const call of calls) {
      expect(call.cwd).toBe("/home/user")
      expect(call.env).toEqual({ GIT_TERMINAL_PROMPT: "0" })
      expect(JSON.stringify(call)).not.toContain(FAKE_TOKEN)
    }
  })

  it("stops at the first failing step and reports it with the stderr tail", async () => {
    const seen: string[] = []
    const result = await runSandboxWorkspaceSetup(async opts => {
      seen.push(opts.command)
      if (opts.command.includes("git clone")) {
        return { exitCode: 128, stdout: "", stderr: "fatal: Authentication failed", durationMs: 1 }
      }
      return ok()
    }, plan)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.step).toBe("git-clone")
    expect(result.message).toContain("exit 128")
    expect(result.message).toContain("Authentication failed")
    expect(seen.some(c => c.includes("checkout"))).toBe(false)
  })

  it("reports a throwing exec and an unparseable base sha as failures", async () => {
    const thrown = await runSandboxWorkspaceSetup(async () => {
      throw new Error("envd unreachable")
    }, plan)
    expect(thrown).toMatchObject({ ok: false, step: "git-identity", message: "envd unreachable" })
    const garbled = await runSandboxWorkspaceSetup(async opts => ok(opts.command.includes("rev-parse") ? "nope" : ""), plan)
    expect(garbled).toMatchObject({ ok: false, step: "resolve-base" })
  })
})

describe("withoutReservedSandboxEnv", () => {
  it("drops AGENTPROTO_GIT_TOKEN from every caller-declared env slot and keeps the rest", () => {
    const spec = withoutReservedSandboxEnv({
      provider: "e2b",
      config: {},
      env: {
        passthrough: ["KEEP_ME", GIT_TOKEN_ENV],
        auth: { state: { env: [GIT_TOKEN_ENV, "ALSO_KEPT"] } },
      },
      join: { tokenEnv: GIT_TOKEN_ENV },
    } as Parameters<typeof withoutReservedSandboxEnv>[0])
    expect(spec.env?.passthrough).toEqual(["KEEP_ME"])
    expect(spec.env?.auth?.state?.env).toEqual(["ALSO_KEPT"])
    expect(spec.join?.tokenEnv).toBeUndefined()
  })

  it("drops GH_TOKEN from every caller-declared env slot too", () => {
    const spec = withoutReservedSandboxEnv({
      provider: "e2b",
      config: {},
      env: {
        passthrough: [GH_TOKEN_ENV, "KEEP_ME"],
        auth: { state: { env: ["ALSO_KEPT", GH_TOKEN_ENV] } },
      },
      join: { tokenEnv: GH_TOKEN_ENV },
    } as Parameters<typeof withoutReservedSandboxEnv>[0])
    expect(spec.env?.passthrough).toEqual(["KEEP_ME"])
    expect(spec.env?.auth?.state?.env).toEqual(["ALSO_KEPT"])
    expect(spec.join?.tokenEnv).toBeUndefined()
  })

  it("returns a spec without env untouched", () => {
    const spec = { provider: "e2b", config: {} }
    expect(withoutReservedSandboxEnv(spec)).toBe(spec)
  })
})

describe("withGhTokenAlias", () => {
  const resolve = async (slug: string) =>
    ({ [GIT_TOKEN_ENV]: "workspace-token", [GH_TOKEN_ENV]: "operator-gh-token", OTHER: "other" })[slug] ?? null

  it("answers GH_TOKEN with the workspace git token, never a same-named daemon env var", async () => {
    const aliased = withGhTokenAlias(resolve, true)
    expect(await aliased(GH_TOKEN_ENV)).toBe("workspace-token")
    expect(await aliased(GIT_TOKEN_ENV)).toBe("workspace-token")
    expect(await aliased("OTHER")).toBe("other")
  })

  it("resolves GH_TOKEN to null when the box has no workspace git token", async () => {
    const aliased = withGhTokenAlias(resolve, false)
    expect(await aliased(GH_TOKEN_ENV)).toBeNull()
    expect(await aliased("OTHER")).toBe("other")
  })
})

describe("learnWorkBranch", () => {
  const SHA = "b".repeat(40)

  it("reads the current branch and its merge-base with the base ref in one command", () => {
    const cmd = buildLearnBranchCommand("/home/user/agentproto", "origin/main")
    expect(cmd).toContain("cd '/home/user/agentproto'")
    expect(cmd).toContain("git rev-parse --abbrev-ref HEAD")
    expect(cmd).toContain("git merge-base HEAD 'origin/main^{commit}'")
  })

  it("parses a wt/ branch with its fork point", () => {
    expect(parseLearnedWorkBranch(`branch=wt/by-hand\nbase=${SHA}\n`)).toEqual({ branch: "wt/by-hand", baseSha: SHA })
  })

  it("keeps the branch but no baseSha when git could not compute a merge-base", () => {
    expect(parseLearnedWorkBranch("branch=wt/by-hand\nbase=\n")).toEqual({ branch: "wt/by-hand" })
  })

  it("records nothing for the default branch, a detached HEAD or garbage", () => {
    expect(parseLearnedWorkBranch(`branch=main\nbase=${SHA}`)).toBeUndefined()
    expect(parseLearnedWorkBranch(`branch=HEAD\nbase=${SHA}`)).toBeUndefined()
    expect(parseLearnedWorkBranch("")).toBeUndefined()
  })

  it("resolves undefined on a failed or throwing exec instead of throwing", async () => {
    const failed = async () => ({ exitCode: 128, stdout: "", stderr: "fatal", durationMs: 1 })
    expect(await learnWorkBranch(failed, "/x", "origin/main")).toBeUndefined()
    const boom = async (): Promise<SandboxExecResult> => {
      throw new Error("box gone")
    }
    expect(await learnWorkBranch(boom, "/x", "origin/main")).toBeUndefined()
  })

  it("returns the learned branch from a successful exec", async () => {
    const exec = async () => ok(`branch=wt/by-hand\nbase=${SHA}\n`)
    expect(await learnWorkBranch(exec, "/x", "origin/main")).toEqual({ branch: "wt/by-hand", baseSha: SHA })
  })
})
