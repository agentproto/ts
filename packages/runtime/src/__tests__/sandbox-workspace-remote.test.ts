/**
 * Sandbox checkout of a workspace `remote`: the generated setup commands and
 * the runner that executes them through an `exec` seam. Hermetic — `exec` is a
 * fake, nothing here shells out or touches a network. The token is a fake value
 * that must never appear in any command.
 */

import { describe, it, expect } from "vitest"
import type { SandboxExecOpts, SandboxExecResult } from "@agentproto/sandbox"

import {
  GIT_TOKEN_ENV,
  planSandboxWorkspace,
  runSandboxWorkspaceSetup,
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
  it("clones into <home>/<slug> and checks out the default branch when no worktree is requested", () => {
    const plan = planSandboxWorkspace(request)
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

  it("plans no checkpoint restore without a work branch", () => {
    const plan = planSandboxWorkspace({ ...request })
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

  it("returns a spec without env untouched", () => {
    const spec = { provider: "e2b", config: {} }
    expect(withoutReservedSandboxEnv(spec)).toBe(spec)
  })
})
