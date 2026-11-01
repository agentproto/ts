/**
 * gc's "dirty, but no work" reclaim (dirty-no-work.ts + `resolveGcClass`).
 * Three dirt shapes observed on 2026-11-01 left integrated worktrees for a
 * manual `git worktree remove --force`: an emptied checkout, turbo's managed
 * `AGENTS.md` block, and uncommitted changes already on base. Each one must
 * now reclaim through gc (non-force removal), and anything one byte beyond
 * them must keep today's class. Real disposable repos, fake forge, same
 * posture as gc.test.ts.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { mkdtemp, rm, writeFile, mkdir, realpath, readFile, readdir, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const spawnSpy = vi.fn()
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      spawnSpy(...args)
      return actual.spawn(...args)
    },
  }
})

import { execGit } from "../exec.js"
import { planGc, applyGc } from "../gc.js"
import { proveDirtCarriesNoWork } from "../dirty-no-work.js"
import { InMemoryVerdictMemoStore } from "../status.js"
import type { ForgeClient, ForgePullRequestRef } from "../forge.js"

vi.setConfig({ testTimeout: 60_000 })

const FROZEN_NOW = () => "2026-11-01T00:00:00.000Z"

const TURBO_BLOCK = [
  "<!-- BEGIN:turborepo-agent-rules -->",
  "",
  "# This is NOT the Turborepo you know",
  "",
  "Turborepo configuration, task behavior, and CLI commands can vary between installed versions.",
  "",
  "This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected.",
  "<!-- END:turborepo-agent-rules -->",
  "",
].join("\n")

const AGENTS_MD = "# Agent instructions\n\nRun the gate.\n"

class FakeForgeClient implements ForgeClient {
  constructor(private readonly byBranch: ForgePullRequestRef[] = []) {}
  async pullRequestsForBranch(): Promise<ForgePullRequestRef[]> {
    return this.byBranch
  }
  async pullRequestsForCommit(): Promise<ForgePullRequestRef[]> {
    return []
  }
  async ensurePullHeadFetched(): Promise<void> {}
}

beforeEach(() => spawnSpy.mockClear())

const cleanupPaths: string[] = []
afterEach(async () => {
  while (cleanupPaths.length) await rm(cleanupPaths.pop()!, { recursive: true, force: true })
})

function forcedRemoveCalls(): unknown[][] {
  return spawnSpy.mock.calls.filter(
    (call) =>
      call[0] === "git" &&
      Array.isArray(call[1]) &&
      call[1].includes("worktree") &&
      call[1].includes("remove") &&
      call[1].includes("--force"),
  )
}

async function headSha(repo: string): Promise<string> {
  return (await execGit(repo, ["rev-parse", "HEAD"])).stdout.trim()
}

async function commitFiles(repo: string, files: Record<string, string>, message: string): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(repo, path, ".."), { recursive: true })
    await writeFile(join(repo, path), content)
  }
  await execGit(repo, ["add", "-A"])
  await execGit(repo, ["commit", "-m", message])
}

/**
 * A repo whose branch `feat/x` was squash-merged through PR #1 (forge-confirmed),
 * checked out in a linked worktree; `main` then moved on with another PR
 * that edited `src/a.ts` and added `docs/new.md`.
 */
async function mergedWorktree(): Promise<{ repo: string; wtPath: string; forge: ForgeClient }> {
  const repo = await realpath(await mkdtemp(join(tmpdir(), "wt-gc-dnw-")))
  cleanupPaths.push(repo)
  await execGit(repo, ["init", "-b", "main"])
  await execGit(repo, ["config", "user.email", "t@e.com"])
  await execGit(repo, ["config", "user.name", "T"])
  await commitFiles(repo, { "README.md": "hello\n", "AGENTS.md": AGENTS_MD, "src/a.ts": "export const a = 1\n" }, "init")
  await execGit(repo, ["checkout", "-b", "feat/x"])
  await commitFiles(repo, { "src/b.ts": "export const b = 1\n" }, "feat: b")
  const tip = await headSha(repo)
  await execGit(repo, ["checkout", "main"])
  await execGit(repo, ["merge", "--squash", "feat/x"])
  await execGit(repo, ["commit", "-m", "feat: b (#1)"])
  await commitFiles(repo, { "src/a.ts": "export const a = 2\n", "docs/new.md": "landed elsewhere\n" }, "another PR")
  const wtPath = join(repo, "..", `dnw-${Math.random().toString(36).slice(2)}`)
  cleanupPaths.push(wtPath)
  await execGit(repo, ["worktree", "add", wtPath, "feat/x"])
  const forge = new FakeForgeClient([
    { number: 1, state: "closed", merged: true, mergedAt: "2026-10-31T00:00:00.000Z", headRefName: "feat/x", headRefOid: tip },
  ])
  return { repo, wtPath, forge }
}

/** Two hours ahead: every dirty file and the index are past every recency window. */
const LATER = () => Date.now() + 2 * 60 * 60 * 1000

function gcInput(repo: string, forge: ForgeClient) {
  return {
    repoRoot: repo,
    repoName: "test-repo",
    forge,
    memo: new InMemoryVerdictMemoStore(),
    defaultBranchRef: "main",
    now: FROZEN_NOW,
    nowMs: LATER(),
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = []
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (d.name === ".git") continue
    const rel = prefix ? `${prefix}/${d.name}` : d.name
    if (d.isDirectory()) out.push(...(await listFiles(join(dir, d.name), rel)))
    else out.push(rel)
  }
  return out
}

async function expectReclaimed(repo: string, wtPath: string, forge: ForgeClient, cases: string[]): Promise<void> {
  const input = gcInput(repo, forge)
  const plan = await planGc(input)
  const entry = plan.find((e) => e.path === wtPath)
  expect(entry?.tree?.state).toBe("dirty")
  expect(entry?.integration?.state).toBe("merged")
  expect(entry).toMatchObject({ class: "reclaim", reclaimReason: "dirty-no-work", dirtyNoWork: { cases } })

  const outcomes = await applyGc(plan, input)
  expect(outcomes.find((o) => o.path === wtPath)).toMatchObject({ result: "reclaimed", reclaimReason: "dirty-no-work" })
  expect(await exists(wtPath)).toBe(false)
  expect(forcedRemoveCalls()).toHaveLength(0)
}

async function expectKeptAsBefore(repo: string, wtPath: string, forge: ForgeClient): Promise<void> {
  const plan = await planGc(gcInput(repo, forge))
  const entry = plan.find((e) => e.path === wtPath)
  // Today's class for a merged, idle, dirty worktree: salvage (archive only with --salvage-dirty).
  expect(entry?.class).toBe("salvage")
  expect(entry?.reclaimReason).toBeUndefined()
  expect(entry?.dirtyNoWork).toBeUndefined()
}

describe("gc reclaims dirt that carries no work", () => {
  it("case 1: an emptied checkout (every tracked file deleted, nothing else) reclaims", async () => {
    const { repo, wtPath, forge } = await mergedWorktree()
    for (const f of await listFiles(wtPath)) await rm(join(wtPath, f))
    expect(await listFiles(wtPath)).toEqual([])

    await expectReclaimed(repo, wtPath, forge, ["emptied-checkout"])
  })

  it("case 2: turbo's managed AGENTS.md block as the only change reclaims", async () => {
    const { repo, wtPath, forge } = await mergedWorktree()
    await writeFile(join(wtPath, "AGENTS.md"), `${AGENTS_MD}\n${TURBO_BLOCK}`)

    await expectReclaimed(repo, wtPath, forge, ["turbo-managed-block"])
  })

  it("case 3: uncommitted changes byte-identical to base reclaim (modified, untracked, staged)", async () => {
    const { repo, wtPath, forge } = await mergedWorktree()
    await writeFile(join(wtPath, "src/a.ts"), "export const a = 2\n")
    await mkdir(join(wtPath, "docs"), { recursive: true })
    await writeFile(join(wtPath, "docs/new.md"), "landed elsewhere\n")
    await execGit(wtPath, ["add", "docs/new.md"])

    await expectReclaimed(repo, wtPath, forge, ["on-base"])
  })

  it("cases mix: turbo block plus a change already on base reclaims, both sub-cases reported", async () => {
    const { repo, wtPath, forge } = await mergedWorktree()
    await writeFile(join(wtPath, "AGENTS.md"), `${AGENTS_MD}\n${TURBO_BLOCK}`)
    await writeFile(join(wtPath, "src/a.ts"), "export const a = 2\n")

    await expectReclaimed(repo, wtPath, forge, ["on-base", "turbo-managed-block"])
  })
})

describe("gc reclaims dirt that carries no work on a branch proven in base without a merged PR", () => {
  it("a squash-merged branch the forge knows nothing about, dirty only with an on-base change", async () => {
    const { repo, wtPath } = await mergedWorktree()
    await writeFile(join(wtPath, "src/a.ts"), "export const a = 2\n")
    const forge = new FakeForgeClient()
    const input = gcInput(repo, forge)
    const plan = await planGc(input)
    const entry = plan.find((e) => e.path === wtPath)
    expect(entry?.integration?.state).toBe("local-only")
    expect(entry).toMatchObject({ class: "reclaim", reclaimReason: "dirty-no-work", dirtyNoWork: { cases: ["on-base"], paths: 1 } })
    const outcomes = await applyGc(plan, input)
    expect(outcomes.find((o) => o.path === wtPath)).toMatchObject({ result: "reclaimed", reclaimReason: "dirty-no-work" })
    expect(forcedRemoveCalls()).toHaveLength(0)
  })
})

describe("gc keeps today's class when the dirt is unexplained", () => {
  it("an emptied checkout plus one untracked file not on base", async () => {
    const { repo, wtPath, forge } = await mergedWorktree()
    for (const f of await listFiles(wtPath)) await rm(join(wtPath, f))
    await writeFile(join(wtPath, "notes.md"), "my notes\n")

    await expectKeptAsBefore(repo, wtPath, forge)
  })

  it("only some tracked files deleted is not an emptied checkout", async () => {
    const { repo, wtPath, forge } = await mergedWorktree()
    await rm(join(wtPath, "README.md"))

    await expectKeptAsBefore(repo, wtPath, forge)
  })

  it("a real edit next to the turbo block", async () => {
    const { repo, wtPath, forge } = await mergedWorktree()
    await writeFile(join(wtPath, "AGENTS.md"), `${AGENTS_MD}Also run lint.\n\n${TURBO_BLOCK}`)

    await expectKeptAsBefore(repo, wtPath, forge)
  })

  it("an edit inside the turbo markers that drops turbo's heading", async () => {
    const { repo, wtPath, forge } = await mergedWorktree()
    const forged = TURBO_BLOCK.replace("# This is NOT the Turborepo you know", "# My own notes")
    await writeFile(join(wtPath, "AGENTS.md"), `${AGENTS_MD}\n${forged}`)

    await expectKeptAsBefore(repo, wtPath, forge)
  })

  it("a dirty file that differs from base", async () => {
    const { repo, wtPath, forge } = await mergedWorktree()
    await writeFile(join(wtPath, "src/a.ts"), "export const a = 3\n")

    await expectKeptAsBefore(repo, wtPath, forge)
  })

  it("an on-base change next to one that is not", async () => {
    const { repo, wtPath, forge } = await mergedWorktree()
    await writeFile(join(wtPath, "src/a.ts"), "export const a = 2\n")
    await writeFile(join(wtPath, "src/b.ts"), "export const b = 42\n")

    await expectKeptAsBefore(repo, wtPath, forge)
  })

  it("a staged version that differs from base, even when the working tree matches it", async () => {
    const { repo, wtPath, forge } = await mergedWorktree()
    await writeFile(join(wtPath, "src/a.ts"), "export const a = 99\n")
    await execGit(wtPath, ["add", "src/a.ts"])
    await writeFile(join(wtPath, "src/a.ts"), "export const a = 2\n")

    await expectKeptAsBefore(repo, wtPath, forge)
  })

  it("an unresolvable base ref proves nothing", async () => {
    const { wtPath, repo } = await mergedWorktree()
    await writeFile(join(wtPath, "src/a.ts"), "export const a = 2\n")
    expect(await proveDirtCarriesNoWork(repo, wtPath, "refs/heads/does-not-exist")).toBeNull()
    expect(await proveDirtCarriesNoWork(repo, wtPath, "main")).toMatchObject({ cases: ["on-base"] })
  })

  it("a dirt-free proof is null, and the turbo file is untouched by a plan", async () => {
    const { repo, wtPath } = await mergedWorktree()
    expect(await proveDirtCarriesNoWork(repo, wtPath, "main")).toBeNull()
    await writeFile(join(wtPath, "AGENTS.md"), `${AGENTS_MD}\n${TURBO_BLOCK}`)
    await proveDirtCarriesNoWork(repo, wtPath, "main")
    expect(await readFile(join(wtPath, "AGENTS.md"), "utf8")).toBe(`${AGENTS_MD}\n${TURBO_BLOCK}`)
  })
})
