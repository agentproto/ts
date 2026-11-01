/**
 * Incident 2026-11-01: `agentproto maintain` run from a linked worktree's
 * build called `app_install {dir: <worktree>/packages/apps/repo-maintenance}`
 * and re-pointed the GLOBAL installed-app record into the worktree; once the
 * worktree was removed the app was `dir-missing` for every caller and nothing
 * repaired it. Two halves: an implicit re-point into a linked worktree is
 * refused, and a record already broken that way heals from the main worktree.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineApp } from "@agentproto/app"
import { defineAgent } from "@agentproto/agent"
import { defineWorkflow } from "@agentproto/workflow"
import { createAppRegistry, type AppRegistry } from "../app-registry.js"
import { APP_INSTALL_WORKTREE_REPOINT_REFUSED, performInstall, repairWorktreeMissingApps } from "../app-tools.js"
import { resolveMainRepoPath, resolveWorktreeIdentity } from "../worktree-identity.js"

const APP_REL = join("packages", "apps", "fx")

let root: string
let mainRepo: string
let worktree: string
let workspacesConfigPath: string
let reg: AppRegistry

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdio: "ignore",
  })
}

async function emitApp(id: string, dir: string, dataDir?: string): Promise<void> {
  await defineApp({
    id,
    name: id,
    ...(dataDir !== undefined ? { data: { dir: dataDir } } : {}),
    agents: [
      {
        agent: defineAgent({
          schema: "agent/v1",
          id: "worker",
          description: "A worker agent.",
          model: "claude-sonnet-5",
          workflows: [{ ref: "maintain" }],
        }),
        body: "You do the thing.",
      },
    ],
    workflows: [
      defineWorkflow({
        id: "maintain",
        name: "maintain",
        description: "Does a thing.",
        version: "0.1.0",
        inputs: {},
        outputs: {},
        steps: [{ id: "s", kind: "tool", tool: "known_tool" }],
      }),
    ],
  }).emit(dir)
}

function install(dir: string, extra?: { allowWorktreeRepoint?: boolean }) {
  return performInstall(dir, reg, async () => [], undefined, {
    skipDaemonChecks: true,
    workspacesConfigPath,
    ...extra,
  })
}

async function writeWorkspaces(paths: string[]): Promise<void> {
  const now = new Date().toISOString()
  await writeFile(
    workspacesConfigPath,
    JSON.stringify({
      version: 1,
      workspaces: paths.map((path, i) => ({ slug: `ws-${i}`, path, addedAt: now, updatedAt: now })),
    }),
  )
}

/** Install from the linked worktree on purpose, then remove the worktree:
 *  the broken state the incident left behind. */
async function breakIntoRemovedWorktree(): Promise<string> {
  await emitApp("@t/fx", join(worktree, APP_REL))
  const r = await install(join(worktree, APP_REL), { allowWorktreeRepoint: true })
  expect(r.ok).toBe(true)
  git(mainRepo, "worktree", "remove", "--force", worktree)
  return join(worktree, APP_REL)
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "app-reg-wt-")))
  mainRepo = join(root, "repo")
  worktree = join(root, "worktrees", "repo", "feature")
  workspacesConfigPath = join(root, "workspaces.json")
  await mkdir(mainRepo, { recursive: true })
  git(mainRepo, "init", "-q", "-b", "main")
  await writeFile(join(mainRepo, "README.md"), "x\n")
  git(mainRepo, "add", "README.md")
  git(mainRepo, "commit", "-q", "-m", "init")
  await mkdir(join(root, "worktrees", "repo"), { recursive: true })
  git(mainRepo, "worktree", "add", "-q", "-b", "feature", worktree)
  reg = createAppRegistry({ persistPath: join(root, "apps.json") })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("git worktree classification", () => {
  it("treats a submodule and a --separate-git-dir checkout as primary checkouts, never linked worktrees", async () => {
    const sub = join(mainRepo, "vendor", "sub")
    await mkdir(join(mainRepo, "vendor"), { recursive: true })
    const subOrigin = join(root, "sub-origin")
    await mkdir(subOrigin, { recursive: true })
    git(subOrigin, "init", "-q", "-b", "main")
    await writeFile(join(subOrigin, "f"), "x\n")
    git(subOrigin, "add", "f")
    git(subOrigin, "commit", "-q", "-m", "init")
    git(mainRepo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", subOrigin, "vendor/sub")
    const sep = join(root, "sep")
    git(root, "init", "-q", "-b", "main", "--separate-git-dir", join(root, "sep.git"), sep)

    for (const checkout of [sub, sep]) {
      expect(resolveWorktreeIdentity(join(checkout, APP_REL))).toBeUndefined()
      expect(resolveMainRepoPath(join(checkout, APP_REL))).toBe(checkout)
    }
    // ...so installing from one over a live install is not refused.
    await emitApp("@t/fx", join(mainRepo, APP_REL))
    await emitApp("@t/fx", join(sub, APP_REL))
    await emitApp("@t/fx", join(sep, APP_REL))
    expect((await install(join(mainRepo, APP_REL))).ok).toBe(true)
    expect((await install(join(sub, APP_REL))).ok).toBe(true)
    expect((await install(join(sep, APP_REL))).ok).toBe(true)
    expect(reg.getApp("@t/fx")!.dir).toBe(join(sep, APP_REL))
  })

  it("tells a linked worktree from the main one, and finds the main worktree from either", () => {
    expect(resolveWorktreeIdentity(join(mainRepo, APP_REL))).toBeUndefined()
    expect(resolveWorktreeIdentity(join(worktree, APP_REL))).toMatchObject({ worktreePath: worktree, mainRepoPath: mainRepo })
    expect(resolveMainRepoPath(join(worktree, APP_REL))).toBe(mainRepo)
    expect(resolveMainRepoPath(join(mainRepo, APP_REL))).toBe(mainRepo)
    expect(resolveMainRepoPath(join(root, "elsewhere"))).toBeUndefined()
  })
})

describe("app install: no implicit re-point into a linked worktree", () => {
  it("refuses to move an app installed from a live main checkout into a worktree", async () => {
    await emitApp("@t/fx", join(mainRepo, APP_REL))
    await emitApp("@t/fx", join(worktree, APP_REL))
    expect((await install(join(mainRepo, APP_REL))).ok).toBe(true)

    const r = await install(join(worktree, APP_REL))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain(APP_INSTALL_WORKTREE_REPOINT_REFUSED)
    expect(!r.ok && r.error).toContain(worktree)
    expect(reg.getApp("@t/fx")!.dir).toBe(join(mainRepo, APP_REL))
  })

  it("re-points into the worktree when asked explicitly", async () => {
    await emitApp("@t/fx", join(mainRepo, APP_REL))
    await emitApp("@t/fx", join(worktree, APP_REL))
    expect((await install(join(mainRepo, APP_REL))).ok).toBe(true)
    expect((await install(join(worktree, APP_REL), { allowWorktreeRepoint: true })).ok).toBe(true)
    expect(reg.getApp("@t/fx")!.dir).toBe(join(worktree, APP_REL))
  })

  it("still installs from a worktree when the app is new, or its installed dir is gone", async () => {
    await emitApp("@t/fx", join(worktree, APP_REL))
    expect((await install(join(worktree, APP_REL))).ok).toBe(true)
    reg.upsertApp({ ...reg.getApp("@t/fx")!, dir: join(root, "gone") })
    expect((await install(join(worktree, APP_REL))).ok).toBe(true)
    expect(reg.getApp("@t/fx")!.dir).toBe(join(worktree, APP_REL))
  })
})

describe("self-heal: dir-missing record from a removed linked worktree", () => {
  it("re-points to the main worktree copy found through a workspace root, and records it", async () => {
    await emitApp("@t/fx", join(mainRepo, APP_REL))
    const dead = await breakIntoRemovedWorktree()
    await writeWorkspaces([mainRepo])
    expect(reg.listIssues().map(i => i.kind)).toEqual(["dir-missing"])

    expect(await repairWorktreeMissingApps(reg, async () => [], undefined, { workspacesConfigPath })).toEqual(["@t/fx"])
    const app = reg.getApp("@t/fx")!
    expect(app.dir).toBe(join(mainRepo, APP_REL))
    expect(app.workflows.map(w => w.path)).toEqual([join(mainRepo, APP_REL, ".agentproto/workflows/maintain/WORKFLOW.md")])
    // The default dataDir lived under the dead dir: resolved afresh under the new one.
    expect(app.dataDir).toBe(join(mainRepo, APP_REL, "data"))
    // Healed: no issue left, the repair reported apart.
    expect(reg.listIssues()).toEqual([])
    expect(reg.listRepairs()).toEqual([
      { kind: "dir-repointed", appId: "@t/fx", from: dead, to: join(mainRepo, APP_REL), at: expect.any(String) },
    ])
    // A second pass changes nothing, and a repeated record replaces rather than stacks.
    expect(await repairWorktreeMissingApps(reg, async () => [], undefined, { workspacesConfigPath })).toEqual([])
    reg.recordRepoint("@t/fx", "/elsewhere", join(mainRepo, APP_REL))
    expect(reg.listRepairs()).toHaveLength(1)
    expect(reg.listRepairs()[0]!.from).toBe("/elsewhere")
  })

  it("a dataDir equal to the dead app dir resolves afresh to <to>/data, not the app root", async () => {
    await emitApp("@t/fx", join(mainRepo, APP_REL))
    const dead = await breakIntoRemovedWorktree()
    reg.upsertApp({ ...reg.getApp("@t/fx")!, dataDir: dead })
    await writeWorkspaces([mainRepo])
    expect(await repairWorktreeMissingApps(reg, async () => [], undefined, { workspacesConfigPath })).toEqual(["@t/fx"])
    expect(reg.getApp("@t/fx")!.dataDir).toBe(join(mainRepo, APP_REL, "data"))
  })

  it("a dataDir under the dead dir follows the main copy's APP.md data.dir hint", async () => {
    await emitApp("@t/fx", join(mainRepo, APP_REL), "store")
    await breakIntoRemovedWorktree()
    await writeWorkspaces([mainRepo])
    expect(await repairWorktreeMissingApps(reg, async () => [], undefined, { workspacesConfigPath })).toEqual(["@t/fx"])
    expect(reg.getApp("@t/fx")!.dataDir).toBe(join(mainRepo, APP_REL, "store"))
  })

  it("a dataDir outside the dead dir is live data and is kept", async () => {
    await emitApp("@t/fx", join(mainRepo, APP_REL))
    await breakIntoRemovedWorktree()
    const outside = join(root, "kept-data")
    reg.upsertApp({ ...reg.getApp("@t/fx")!, dataDir: outside })
    await writeWorkspaces([mainRepo])
    expect(await repairWorktreeMissingApps(reg, async () => [], undefined, { workspacesConfigPath })).toEqual(["@t/fx"])
    expect(reg.getApp("@t/fx")!.dataDir).toBe(outside)
  })

  it("finds the main worktree through another installed app's live dir", async () => {
    await emitApp("@t/fx", join(mainRepo, APP_REL))
    await emitApp("@t/other", join(mainRepo, "packages", "apps", "other"))
    expect((await install(join(mainRepo, "packages", "apps", "other"))).ok).toBe(true)
    await breakIntoRemovedWorktree()
    expect(await repairWorktreeMissingApps(reg, async () => [], undefined, { workspacesConfigPath })).toEqual(["@t/fx"])
    expect(reg.getApp("@t/fx")!.dir).toBe(join(mainRepo, APP_REL))
  })

  it("leaves it dir-missing when the main copy declares a different appId", async () => {
    await emitApp("@t/not-fx", join(mainRepo, APP_REL))
    const dead = await breakIntoRemovedWorktree()
    await writeWorkspaces([mainRepo])
    expect(await repairWorktreeMissingApps(reg, async () => [], undefined, { workspacesConfigPath })).toEqual([])
    expect(reg.getApp("@t/fx")!.dir).toBe(dead)
    expect(reg.listIssues().map(i => i.kind)).toEqual(["dir-missing"])
  })

  it("leaves it dir-missing when the main worktree has no copy", async () => {
    const dead = await breakIntoRemovedWorktree()
    await writeWorkspaces([mainRepo])
    expect(await repairWorktreeMissingApps(reg, async () => [], undefined, { workspacesConfigPath })).toEqual([])
    expect(reg.getApp("@t/fx")!.dir).toBe(dead)
    expect(reg.listIssues().map(i => i.kind)).toEqual(["dir-missing"])
  })

  it("leaves it dir-missing when no known root leads to a main worktree", async () => {
    await emitApp("@t/fx", join(mainRepo, APP_REL))
    const dead = await breakIntoRemovedWorktree()
    expect(await repairWorktreeMissingApps(reg, async () => [], undefined, { workspacesConfigPath })).toEqual([])
    expect(reg.getApp("@t/fx")!.dir).toBe(dead)
  })

  it("leaves it dir-missing when two main worktrees both hold a matching copy", async () => {
    await emitApp("@t/fx", join(mainRepo, APP_REL))
    const otherRepo = join(root, "other-repo")
    await mkdir(otherRepo, { recursive: true })
    git(otherRepo, "init", "-q", "-b", "main")
    await emitApp("@t/fx", join(otherRepo, APP_REL))
    const dead = await breakIntoRemovedWorktree()
    await writeWorkspaces([mainRepo, otherRepo])
    expect(await repairWorktreeMissingApps(reg, async () => [], undefined, { workspacesConfigPath })).toEqual([])
    expect(reg.getApp("@t/fx")!.dir).toBe(dead)
  })
})
