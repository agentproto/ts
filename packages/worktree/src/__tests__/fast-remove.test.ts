/**
 * `removeWorktreeFast` / `sweepWorktreeTrash` (fast-remove.ts): the rename +
 * prune + background-delete removal. Real git fixtures, real renames — the
 * only thing faked is the detached `rm -rf` child (a spy, so these tests
 * don't leak thousands of background unlinks), except the last test, which
 * lets the real child run and polls for its completion.
 */

import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, mkdir, readdir, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { realpathSync } from "node:fs"
import { removeWorktreeFast, sweepWorktreeTrash, WORKTREE_TRASH_DIRNAME } from "../fast-remove.js"
import { execGit } from "../exec.js"

const cleanupPaths: string[] = []

afterEach(async () => {
	while (cleanupPaths.length) {
		const p = cleanupPaths.pop()!
		await rm(p, { recursive: true, force: true }).catch(() => {})
	}
})

async function makeRepo(): Promise<string> {
	// realpath so macOS /tmp → /private/tmp symlinking doesn't defeat equality.
	const repoRoot = realpathSync(await mkdtemp(join(tmpdir(), "wt-fast-repo-")))
	cleanupPaths.push(repoRoot)
	await execGit(repoRoot, ["init", "-b", "main"])
	await execGit(repoRoot, ["config", "user.email", "test@example.com"])
	await execGit(repoRoot, ["config", "user.name", "Test"])
	await writeFile(join(repoRoot, "README.md"), "hello\n")
	await execGit(repoRoot, ["add", "."])
	await execGit(repoRoot, ["commit", "-m", "init"])
	return repoRoot
}

async function addWorktree(repoRoot: string, slug: string): Promise<string> {
	const wtDir = join(repoRoot, "pool", slug)
	await execGit(repoRoot, ["worktree", "add", wtDir, "-b", `wt/${slug}`])
	cleanupPaths.push(wtDir)
	return wtDir
}

/** The captured trash dirs of a run whose background child is a no-op spy. */
function spyRemoval(): { dirs: string[]; spawnRemoval: (dir: string) => void } {
	const dirs: string[] = []
	return { dirs, spawnRemoval: (dir) => dirs.push(dir) }
}

async function listWorktreePaths(repoRoot: string): Promise<string[]> {
	const res = await execGit(repoRoot, ["worktree", "list", "--porcelain"])
	return res.stdout
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length).trim())
}

describe("removeWorktreeFast", () => {
	it("removes a clean worktree instantly: dir gone at the original path, pruned from git, bytes parked in the trash for the background child", async () => {
		const repoRoot = await makeRepo()
		const wtDir = await addWorktree(repoRoot, "clean-one")
		const { dirs, spawnRemoval } = spyRemoval()

		await removeWorktreeFast(repoRoot, wtDir, { spawnRemoval })

		// 1. No dir at the original path, immediately.
		expect(existsSync(wtDir)).toBe(false)
		// 2. `git worktree list` no longer shows it.
		const listed = await listWorktreePaths(repoRoot)
		expect(listed).not.toContain(wtDir)
		// 3. The bytes were renamed (not copied) into the same-volume trash dir,
		//    still readable there — the background child is the only thing that
		//    deletes them.
		expect(dirs).toHaveLength(1)
		expect(dirs[0]?.startsWith(join(repoRoot, "pool", WORKTREE_TRASH_DIRNAME))).toBe(true)
		expect(dirs[0]).toContain("clean-one-")
		const trashDir = dirs[0] ?? ""
		expect(await readFile(join(trashDir, "README.md"), "utf8")).toBe("hello\n")
	}, 20_000)

	it("eventually deletes the trash dir when the real detached child runs", async () => {
		const repoRoot = await makeRepo()
		const wtDir = await addWorktree(repoRoot, "bg-delete")
		const trashParent = join(dirname(wtDir), WORKTREE_TRASH_DIRNAME)

		// No spawnRemoval override: the real detached `rm -rf` runs. It never
		// blocks this call — assert that, then poll for the bytes to drain.
		const t0 = Date.now()
		await removeWorktreeFast(repoRoot, wtDir)
		expect(Date.now() - t0).toBeLessThan(10_000)

		const deadline = Date.now() + 10_000
		for (;;) {
			if (!existsSync(trashParent) || (await readdir(trashParent)).length === 0) break
			if (Date.now() > deadline) throw new Error(`trash dir never drained: ${trashParent}`)
			await new Promise((r) => setTimeout(r, 250))
		}
		expect(existsSync(wtDir)).toBe(false)
		const listed = await listWorktreePaths(repoRoot)
		expect(listed).not.toContain(wtDir)
	}, 25_000)

	it("refuses a dirty tree on the non-force path and leaves everything in place", async () => {
		const repoRoot = await makeRepo()
		const wtDir = await addWorktree(repoRoot, "dirty")
		await writeFile(join(wtDir, "README.md"), "edited\n")
		const { dirs, spawnRemoval } = spyRemoval()

		let message = ""
		try {
			await removeWorktreeFast(repoRoot, wtDir, { spawnRemoval })
		} catch (err) {
			message = err instanceof Error ? err.message : String(err)
		}

		// Same refusal shape as `git worktree remove` without --force.
		expect(message).toContain("contains modified or untracked files")
		// Nothing moved, nothing pruned — the worktree is exactly where it was.
		expect(existsSync(wtDir)).toBe(true)
		expect(await listWorktreePaths(repoRoot)).toContain(wtDir)
		expect(dirs).toHaveLength(0)
	}, 20_000)

	it("renames a clean worktree holding only gitignored files (node_modules) to the trash — no slow removal", async () => {
		const repoRoot = await makeRepo()
		await writeFile(join(repoRoot, ".gitignore"), "node_modules/\n")
		await execGit(repoRoot, ["add", ".gitignore"])
		await execGit(repoRoot, ["commit", "-m", "ignore node_modules"])
		const wtDir = await addWorktree(repoRoot, "ignored-only")
		await mkdir(join(wtDir, "node_modules"), { recursive: true })
		await writeFile(join(wtDir, "node_modules", "x"), "dep\n")
		const { dirs, spawnRemoval } = spyRemoval()

		await removeWorktreeFast(repoRoot, wtDir, { spawnRemoval })

		expect(existsSync(wtDir)).toBe(false)
		expect(await listWorktreePaths(repoRoot)).not.toContain(wtDir)
		expect(dirs).toHaveLength(1)
		expect(dirs[0]?.startsWith(join(repoRoot, "pool", WORKTREE_TRASH_DIRNAME))).toBe(true)
		expect(await readFile(join(dirs[0] ?? "", "node_modules", "x"), "utf8")).toBe("dep\n")
	}, 20_000)

	it("refuses a worktree with an untracked, unignored file and leaves it intact", async () => {
		const repoRoot = await makeRepo()
		const wtDir = await addWorktree(repoRoot, "untracked")
		await writeFile(join(wtDir, "new.txt"), "fresh\n")
		const { dirs, spawnRemoval } = spyRemoval()

		await expect(removeWorktreeFast(repoRoot, wtDir, { spawnRemoval })).rejects.toThrow(
			/contains modified or untracked files/,
		)
		expect(existsSync(join(wtDir, "new.txt"))).toBe(true)
		expect(await listWorktreePaths(repoRoot)).toContain(wtDir)
		expect(dirs).toHaveLength(0)
	}, 20_000)

	it("refuses a locked worktree and leaves it registered", async () => {
		const repoRoot = await makeRepo()
		const wtDir = await addWorktree(repoRoot, "locked")
		await execGit(repoRoot, ["worktree", "lock", wtDir])
		const { dirs, spawnRemoval } = spyRemoval()

		await expect(removeWorktreeFast(repoRoot, wtDir, { spawnRemoval })).rejects.toThrow(/locked/)
		expect(existsSync(wtDir)).toBe(true)
		expect(await listWorktreePaths(repoRoot)).toContain(wtDir)
		expect(dirs).toHaveLength(0)
	}, 20_000)

	it("force removes a dirty tree whose dirt was authorized upstream", async () => {
		const repoRoot = await makeRepo()
		const wtDir = await addWorktree(repoRoot, "forced")
		await writeFile(join(wtDir, "README.md"), "edited\n")
		const { dirs, spawnRemoval } = spyRemoval()

		await removeWorktreeFast(repoRoot, wtDir, { force: true, spawnRemoval })

		expect(existsSync(wtDir)).toBe(false)
		expect(await listWorktreePaths(repoRoot)).not.toContain(wtDir)
		expect(dirs).toHaveLength(1)
	}, 20_000)

	it("falls back to plain `git worktree remove` when the rename fails", async () => {
		const repoRoot = await makeRepo()
		const wtDir = await addWorktree(repoRoot, "fallback")
		const { dirs, spawnRemoval } = spyRemoval()

		// Make the rename impossible: a non-empty directory already exists at
		// the exact trash path this removal would rename to (`now` is pinned
		// so the name is deterministic), so `rename` fails (ENOTEMPTY on a
		// dir target) and the fallback path runs the plain removal.
		await mkdir(join(dirname(wtDir), WORKTREE_TRASH_DIRNAME, "fallback-1234567890"), { recursive: true })
		await writeFile(join(dirname(wtDir), WORKTREE_TRASH_DIRNAME, "fallback-1234567890", "x"), "y\n")

		await removeWorktreeFast(repoRoot, wtDir, { spawnRemoval, now: () => 1234567890 })

		// The fallback removed the worktree the slow way — no trash bytes, no
		// registration, dir gone.
		expect(existsSync(wtDir)).toBe(false)
		expect(await listWorktreePaths(repoRoot)).not.toContain(wtDir)
		expect(dirs).toHaveLength(0)
	}, 20_000)

	it("refuses a path that is not a linked worktree of repoRoot", async () => {
		const repoRoot = await makeRepo()
		const other = await makeRepo()
		const { dirs, spawnRemoval } = spyRemoval()

		await expect(removeWorktreeFast(repoRoot, other, { spawnRemoval })).rejects.toThrow(
			/not a linked worktree/,
		)
		expect(dirs).toHaveLength(0)
	}, 20_000)
})

describe("sweepWorktreeTrash", () => {
	it("hands every leftover .trash/* dir to the background child and never touches non-trash files", async () => {
		const root = await mkdtemp(join(tmpdir(), "wt-fast-root-"))
		cleanupPaths.push(root)
		const trash = join(root, WORKTREE_TRASH_DIRNAME)
		await mkdir(join(trash, "stale-wt-123"), { recursive: true })
		await mkdir(join(trash, "stale-wt-456"), { recursive: true })
		await writeFile(join(trash, "stale-wt-123", "leftover"), "bytes\n")
		await writeFile(join(root, "live-worktree"), "not trash\n")
		const swept: string[] = []

		sweepWorktreeTrash(root, { spawnRemoval: (d) => swept.push(d) })

		expect(swept.sort()).toEqual([join(trash, "stale-wt-123"), join(trash, "stale-wt-456")].sort())
		// The non-trash entry was never swept; nothing was deleted synchronously
		// (the child owns deletion) — only handed off.
		expect(existsSync(join(root, "live-worktree"))).toBe(true)
		expect(existsSync(join(trash, "stale-wt-123", "leftover"))).toBe(true)
	})

	it("is a no-op on a missing root", () => {
		const swept: string[] = []
		expect(() => sweepWorktreeTrash("/nonexistent/wt-fast-root", { spawnRemoval: (d) => swept.push(d) })).not.toThrow()
		expect(swept).toHaveLength(0)
	})
})
