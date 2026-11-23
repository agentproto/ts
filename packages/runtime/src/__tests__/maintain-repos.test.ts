/**
 * `resolveMaintainRepos`: the repo set shared by `maintain --all` and the
 * daemon's `maintain_run` — discover on/off, `maintain.repos` added,
 * `maintain.exclude` removed, every entry deduped by the realpath of its
 * main repo root. Real git fixtures (linked worktrees under a worktrees root).
 */

import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { maintainWorkflowInput, readMaintainConfig, resolveMaintainRepos } from "../maintain-repos.js"

const cleanup: string[] = []
afterEach(async () => {
	for (const p of cleanup.splice(0)) await rm(p, { recursive: true, force: true }).catch(() => {})
})

function git(cwd: string, ...args: string[]): void {
	const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
	if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`)
}

async function tmp(prefix: string): Promise<string> {
	const dir = realpathSync(await mkdtemp(join(tmpdir(), prefix)))
	cleanup.push(dir)
	return dir
}

async function makeRepo(name: string): Promise<string> {
	const root = await tmp(`maintain-repos-${name}-`)
	git(root, "init", "-q", "-b", "main")
	git(root, "config", "user.email", "t@t.t")
	git(root, "config", "user.name", "t")
	await writeFile(join(root, "f"), "x")
	await mkdir(join(root, "sub", "dir"), { recursive: true })
	await writeFile(join(root, "sub", "dir", "g"), "y")
	git(root, "add", ".")
	git(root, "commit", "-q", "-m", "init")
	return root
}

/** A worktrees root holding one linked worktree per given repo. */
async function makeWorktreesRoot(repos: string[]): Promise<string> {
	const root = await tmp("maintain-repos-root-")
	for (const [i, repo] of repos.entries()) {
		const wt = join(root, `bucket-${i}`, "wt")
		await mkdir(join(root, `bucket-${i}`), { recursive: true })
		git(repo, "worktree", "add", "-q", wt, "-b", `wt/${i}`)
	}
	return root
}

const env = {} as NodeJS.ProcessEnv
const NO_WS: never[] = []

describe("resolveMaintainRepos", () => {
	it("discovers the repos owning a worktree under the root by default", { timeout: 30_000 }, async () => {
		const a = await makeRepo("a")
		const b = await makeRepo("b")
		const root = await makeWorktreesRoot([a, b])
		const res = await resolveMaintainRepos({}, { worktreesRoot: root, env, workspaces: NO_WS })
		expect(res.repos).toEqual([a, b].sort())
		expect(res.excluded).toEqual([])
	})

	it("discover:false scans nothing and keeps only maintain.repos", { timeout: 30_000 }, async () => {
		const a = await makeRepo("a")
		const c = await makeRepo("c")
		const root = await makeWorktreesRoot([a])
		const res = await resolveMaintainRepos(
			{ maintain: { discover: false, repos: [c] } },
			{ worktreesRoot: root, env, workspaces: NO_WS },
		)
		expect(res.repos).toEqual([c])
		expect(res.scannedRoots).toEqual([])
	})

	it("adds maintain.repos on top of discovery, normalised to the repo root", { timeout: 30_000 }, async () => {
		const a = await makeRepo("a")
		const c = await makeRepo("c")
		const root = await makeWorktreesRoot([a])
		// A subdir of c names c.
		const res = await resolveMaintainRepos(
			{ maintain: { repos: [join(c, "sub", "dir")] } },
			{ worktreesRoot: root, env, workspaces: NO_WS },
		)
		expect(res.repos).toEqual([a, c])
	})

	it("removes maintain.exclude, matching a worktree or subdir of the excluded repo", { timeout: 30_000 }, async () => {
		const a = await makeRepo("a")
		const b = await makeRepo("b")
		const root = await makeWorktreesRoot([a, b])
		// Exclude b through its linked worktree path: still b.
		const res = await resolveMaintainRepos(
			{ maintain: { exclude: [join(root, "bucket-1", "wt")] } },
			{ worktreesRoot: root, env, workspaces: NO_WS },
		)
		expect(res.repos).toEqual([a])
		expect(res.excluded).toEqual([b])
	})

	it("an explicit repo is added even when excluded, and nothing is listed twice", { timeout: 30_000 }, async () => {
		const a = await makeRepo("a")
		const b = await makeRepo("b")
		const root = await makeWorktreesRoot([a, b])
		const res = await resolveMaintainRepos(
			{ maintain: { repos: [a, join(a, "sub")], exclude: [b] } },
			{ worktreesRoot: root, repos: [b, a], env, workspaces: NO_WS },
		)
		expect(res.repos).toEqual([a, b])
	})

	it("dedups by realpath: a symlinked path to a discovered repo is the same repo", { timeout: 30_000 }, async () => {
		const a = await makeRepo("a")
		const root = await makeWorktreesRoot([a])
		const links = await tmp("maintain-repos-links-")
		await symlink(a, join(links, "a-link"))
		const res = await resolveMaintainRepos(
			{ maintain: { repos: [join(links, "a-link")] } },
			{ worktreesRoot: root, env, workspaces: NO_WS },
		)
		expect(res.repos).toEqual([a])
	})

	it("reports a maintain.repos entry outside any repo as skipped, not fatal", { timeout: 30_000 }, async () => {
		const a = await makeRepo("a")
		const plain = await tmp("maintain-repos-plain-")
		const res = await resolveMaintainRepos(
			{ maintain: { discover: false, repos: [plain, a] } },
			{ env, workspaces: NO_WS },
		)
		expect(res.repos).toEqual([a])
		expect(res.skipped).toEqual([{ path: plain, source: "config", reason: "not inside a git repository" }])
	})

	it("scans worktrees.extraRoots with the configured root", { timeout: 30_000 }, async () => {
		const a = await makeRepo("a")
		const b = await makeRepo("b")
		const root = await makeWorktreesRoot([a])
		const extra = await makeWorktreesRoot([b])
		const res = await resolveMaintainRepos({ worktrees: { root, extraRoots: [extra] } }, { env, workspaces: NO_WS })
		expect(res.repos).toEqual([a, b].sort())
	})

	it("throws on an invalid maintain section", async () => {
		await expect(resolveMaintainRepos({ maintain: { repos: "nope" } as never }, { env, workspaces: NO_WS })).rejects.toThrow(
			/invalid `maintain` config: maintain\.repos/,
		)
	})
})

describe("resolveMaintainRepos: the workspace registry (agentproto workspace add)", () => {
	/** A temp HOME holding `.agentproto/workspaces.json` with these entries. */
	async function homeWithRegistry(
		workspaces: Array<{ slug: string; path: string; ownerApp?: string }>,
	): Promise<string> {
		const home = await tmp("maintain-repos-home-")
		await mkdir(join(home, ".agentproto"), { recursive: true })
		const now = new Date().toISOString()
		await writeFile(
			join(home, ".agentproto", "workspaces.json"),
			JSON.stringify({
				version: 1,
				workspaces: workspaces.map(w => ({ ...w, addedAt: now, updatedAt: now })),
			}),
		)
		return home
	}

	it("takes a repo-root workspace; ignores an app workspace in a subdir, a non-git path and an excluded repo", { timeout: 30_000 }, async () => {
		const root = await makeRepo("root")
		const excluded = await makeRepo("excluded")
		const plain = await tmp("maintain-repos-nongit-")
		const home = await homeWithRegistry([
			{ slug: "root", path: root },
			{ slug: "app-x", path: join(root, "sub"), ownerApp: "@agentproto/x" },
			{ slug: "plain", path: plain },
			{ slug: "excluded", path: excluded },
		])
		const emptyRoot = await tmp("maintain-repos-empty-root-")

		const res = await resolveMaintainRepos(
			{ maintain: { exclude: [excluded] } },
			{ home, worktreesRoot: emptyRoot, env },
		)

		expect(res.repos).toEqual([root])
		expect(res.excluded).toEqual([excluded])
	})

	it("ignores a non-app workspace that is a subdir of a repo, not its toplevel", { timeout: 30_000 }, async () => {
		const repo = await makeRepo("r")
		const home = await homeWithRegistry([{ slug: "sub", path: join(repo, "sub", "dir") }])
		const res = await resolveMaintainRepos(
			{ maintain: { discover: false } },
			{ home, env },
		)
		expect(res.repos).toEqual([])
	})

	it("maintain.workspaces:false skips the registry; registry + discovery + maintain.repos combine otherwise", { timeout: 30_000 }, async () => {
		const ws = await makeRepo("ws")
		const disc = await makeRepo("disc")
		const extra = await makeRepo("extra")
		const root = await makeWorktreesRoot([disc])
		const home = await homeWithRegistry([{ slug: "ws", path: ws }])

		const off = await resolveMaintainRepos({ maintain: { workspaces: false } }, { home, worktreesRoot: root, env })
		expect(off.repos).toEqual([disc])

		const on = await resolveMaintainRepos({ maintain: { repos: [extra] } }, { home, worktreesRoot: root, env })
		expect(on.repos).toEqual([ws, disc, extra])
	})

	it("an unreadable registry is reported as skipped, not fatal", { timeout: 30_000 }, async () => {
		const a = await makeRepo("a")
		const home = await tmp("maintain-repos-badhome-")
		await mkdir(join(home, ".agentproto"), { recursive: true })
		await writeFile(join(home, ".agentproto", "workspaces.json"), "{not json")
		const res = await resolveMaintainRepos({ maintain: { discover: false, repos: [a] } }, { home, env })
		expect(res.repos).toEqual([a])
		expect(res.skipped.map(s => s.source)).toEqual(["workspaces"])
	})
})

describe("maintainWorkflowInput", () => {
	it("takes maxReviews/reviewPreset/notify from config when the caller gives none", () => {
		const cfg = readMaintainConfig({
			maintain: { maxReviews: 5, reviewPreset: "sonnet", notify: { provider: "telegram", address: "42" } },
		})
		expect(maintainWorkflowInput("/r", { applyMerged: true }, cfg)).toEqual({
			repoRoot: "/r",
			applyMerged: true,
			applyReviewed: false,
			maxReviews: 5,
			reviewPreset: "sonnet",
			notify: { provider: "telegram", address: "42" },
		})
	})

	it("the caller's values win over the config", () => {
		const input = maintainWorkflowInput(
			"/r",
			{ maxReviews: 2, reviewPreset: "opus", notify: { provider: "agentpush", source: "s" } },
			{ maxReviews: 5, reviewPreset: "sonnet", notify: { provider: "telegram", address: "42" } },
		)
		expect(input).toMatchObject({ maxReviews: 2, reviewPreset: "opus", notify: { provider: "agentpush", source: "s" } })
	})

	it("leaves the keys out when neither sets them (workflow defaults apply)", () => {
		expect(maintainWorkflowInput("/r", {}, {})).toEqual({ repoRoot: "/r", applyMerged: false, applyReviewed: false })
	})
})
