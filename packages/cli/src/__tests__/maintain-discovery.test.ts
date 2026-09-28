/**
 * `maintain --all`'s discovery (`maintain-discovery.ts`): real git fixtures —
 * `git init` + `git worktree add` under a temp worktrees root, exactly the
 * layout `worktree new` produces — over two fake repos, plus the shapes that
 * must be ignored (a plain dir, a dir whose `.git` is a directory).
 */

import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { realpathSync, existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { discoverWorktreeOwningRepos, mainRepoOfWorktree, resolveAllRepos } from "../commands/maintain-discovery.js"

const cleanupPaths: string[] = []

afterEach(async () => {
	while (cleanupPaths.length) {
		const p = cleanupPaths.pop()!
		await rm(p, { recursive: true, force: true }).catch(() => {})
	}
})

function git(cwd: string, ...args: string[]): void {
	const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
	if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`)
}

/** A real git repo with one commit, at a realpath'd temp path. */
async function makeRepo(name: string): Promise<string> {
	const root = realpathSync(await mkdtemp(join(tmpdir(), `maintain-all-${name}-`)))
	cleanupPaths.push(root)
	git(root, "init", "-q", "-b", "main")
	git(root, "config", "user.email", "t@t.t")
	git(root, "config", "user.name", "t")
	await writeFile(join(root, "f"), "x")
	git(root, "add", ".")
	git(root, "commit", "-q", "-m", "init")
	return root
}

/**
 * A fake worktrees root in the exact shape `worktree new` writes:
 * `<root>/<repoDir>/<slug>` where `<slug>` is a linked worktree of one of
 * the given repos (bucket dir named after the repo, like `repoLabel` does).
 */
async function makeWorktreesRoot(
	repos: Array<{ repoRoot: string; bucket: string; slugs: string[] }>,
): Promise<string> {
	const root = realpathSync(await mkdtemp(join(tmpdir(), "maintain-all-root-")))
	cleanupPaths.push(root)
	for (const { repoRoot, bucket, slugs } of repos) {
		for (const slug of slugs) {
			const wt = join(root, bucket, slug)
			await mkdir(join(wt), { recursive: true })
			git(repoRoot, "worktree", "add", wt, "-b", `wt/${slug}`)
		}
	}
	return root
}

describe("discoverWorktreeOwningRepos", () => {
	it("returns both main repos, deduped, for a root holding worktrees of two repos", async () => {
		const repoA = await makeRepo("a")
		const repoB = await makeRepo("b")
		const root = await makeWorktreesRoot([
			{ repoRoot: repoA, bucket: "repo-a", slugs: ["one", "two"] },
			{ repoRoot: repoB, bucket: "repo-b", slugs: ["three"] },
		])

		const discovered = await discoverWorktreeOwningRepos(root)

		expect(discovered.sort()).toEqual([repoA, repoB].sort())
	})

	it("ignores a plain dir (no .git) and a dir whose .git is a directory (a main checkout)", async () => {
		const repoA = await makeRepo("a")
		const root = await makeWorktreesRoot([{ repoRoot: repoA, bucket: "repo-a", slugs: ["one"] }])

		// A bucket that's just a plain dir with a file in it.
		const plainBucket = join(root, "not-a-repo", "plain-entry")
		await mkdir(plainBucket, { recursive: true })
		await writeFile(join(plainBucket, "junk.txt"), "not a worktree\n")
		// A bucket entry whose .git is a DIRECTORY — a main checkout dropped
		// inside the root (the shape --all must never adopt).
		const mainCheckout = join(root, "nested-main", "checkout")
		await mkdir(join(mainCheckout, ".git", "objects"), { recursive: true })
		await writeFile(join(mainCheckout, ".git", "HEAD"), "ref: refs/heads/main\n")

		const discovered = await discoverWorktreeOwningRepos(root)
		expect(discovered).toEqual([repoA])
		expect(discovered).not.toContain(plainBucket)
		expect(discovered).not.toContain(mainCheckout)
	})

	it("yields an empty list for a missing root", async () => {
		expect(await discoverWorktreeOwningRepos(join(tmpdir(), "maintain-all-nope-xyz"))).toEqual([])
	})
})

describe("mainRepoOfWorktree", () => {
	it("resolves the main repo through a real linked worktree's gitdir pointer", async () => {
		const repo = await makeRepo("a")
		const root = await makeWorktreesRoot([{ repoRoot: repo, bucket: "repo-a", slugs: ["one"] }])
		const wt = join(root, "repo-a", "one")

		expect(await mainRepoOfWorktree(wt)).toBe(repo)
		expect(existsSync(join(wt, ".git"))).toBe(true)
	})

	it("returns null for a directory whose .git is a directory", async () => {
		const dir = realpathSync(await mkdtemp(join(tmpdir(), "maintain-all-main-")))
		cleanupPaths.push(dir)
		await mkdir(join(dir, "checkout", ".git"), { recursive: true })
		expect(await mainRepoOfWorktree(join(dir, "checkout"))).toBeNull()
	})
})

describe("resolveAllRepos", () => {
	it("appends explicit --repo roots and dedupes against discovery", async () => {
		const repoA = await makeRepo("a")
		const repoB = await makeRepo("b")
		const repoC = await makeRepo("c") // explicit, owns no worktree yet
		const root = await makeWorktreesRoot([
			{ repoRoot: repoA, bucket: "repo-a", slugs: ["one"] },
			{ repoRoot: repoB, bucket: "repo-b", slugs: ["two", "three"] },
		])

		const all = await resolveAllRepos(root, [repoB, repoC])

		expect(all.sort()).toEqual([repoA, repoB, repoC].sort())
	})

	it("passes explicit repos through when the root has nothing", async () => {
		const repoC = await makeRepo("c")
		const empty = realpathSync(await mkdtemp(join(tmpdir(), "maintain-all-empty-")))
		cleanupPaths.push(empty)

		expect(await resolveAllRepos(empty, [repoC])).toEqual([repoC])
		expect(await resolveAllRepos(empty)).toEqual([])
	})
})
