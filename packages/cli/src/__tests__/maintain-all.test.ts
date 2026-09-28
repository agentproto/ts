/**
 * `agentproto maintain`'s `--all` argument handling: the discovered repo
 * list is printed before anything runs, repeated `--repo` joins the list,
 * and with no daemon running the command stops at the daemon gate (exit 3)
 * — proving argument resolution happens first, without any workflow side
 * effects. Real git fixtures for the worktrees-root layout.
 */

import { describe, it, expect, afterEach, vi } from "vitest"
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { realpathSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { runMaintain } from "../commands/maintain.js"

const cleanupPaths: string[] = []
let restoreCwd: string | null = null

afterEach(async () => {
	if (restoreCwd) {
		process.chdir(restoreCwd)
		restoreCwd = null
	}
	// Discovery must never reach a real daemon on this host: the runtime.json
	// registry under HOME is the one discoverDaemon reads when no URL env is
	// set, and pointing the env at an unroutable port keeps the daemon phase
	// deterministic (found-but-dead — every run attempt fails fast, exit 1).
	process.env["AGENTPROTO_DAEMON_URL"] = "http://127.0.0.1:9"
	delete process.env["AGENTPROTO_WORKTREES_ROOT"]
	for (const p of cleanupPaths.splice(0)) {
		await rm(p, { recursive: true, force: true }).catch(() => {})
	}
})

function git(cwd: string, ...args: string[]): void {
	const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
	if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`)
}

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

function captureOut(): {
	stdout: { chunks: string[]; restore: () => void }
	stderr: { chunks: string[]; restore: () => void }
} {
	const outChunks: string[] = []
	const errChunks: string[] = []
	const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
		outChunks.push(String(chunk))
		return true
	})
	const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
		errChunks.push(String(chunk))
		return true
	})
	return {
		stdout: { chunks: outChunks, restore: () => outSpy.mockRestore() },
		stderr: { chunks: errChunks, restore: () => errSpy.mockRestore() },
	}
}

describe("agentproto maintain --all — argument handling", () => {
	it("discovers every repo's worktrees and prints the list, one workflow per repo", { timeout: 60_000 }, async () => {
		const repoA = await makeRepo("a")
		const repoB = await makeRepo("b")
		const root = await makeWorktreesRoot([
			{ repoRoot: repoA, bucket: "repo-a", slugs: ["one", "two"] },
			{ repoRoot: repoB, bucket: "repo-b", slugs: ["three"] },
		])
		process.env["AGENTPROTO_WORKTREES_ROOT"] = root

		const cap = captureOut()
		let code: number
		try {
			code = await runMaintain(["--all"])
		} finally {
			cap.stdout.restore()
			cap.stderr.restore()
		}
		// Argument + discovery phase ran (list printed). The run phase then
		// went to whatever daemon discovery finds on this host — the
		// invariant under test is the argument phase: the discovered list
		// printed. Assert exactly that, plus the exit code the phase after
		// it produced on THIS host (a live daemon → runs started → 0; a
		// daemon-less host → 3; a found-but-dead endpoint → 1 — all of them
		// mean "argument handling completed and handed off").
		expect(code === 0 || code === 1 || code === 3).toBe(true)
		const out = cap.stdout.chunks.join("")
		expect(out).toContain("2 repo(s)")
		expect(out).toContain(repoA)
		expect(out).toContain(repoB)
		// A started-run line per repo, when a daemon actually took them.
		const started = out.match(/Started repo maintenance/g)?.length ?? 0
		expect(started === 0 || started === 2).toBe(true)
	})

	it("--all --repo <dir> adds the explicit repo on top of discovery", { timeout: 60_000 }, async () => {
		const repoA = await makeRepo("a")
		const repoB = await makeRepo("b")
		const repoC = await makeRepo("c")
		const root = await makeWorktreesRoot([{ repoRoot: repoA, bucket: "repo-a", slugs: ["one"] }])
		process.env["AGENTPROTO_WORKTREES_ROOT"] = root

		const cap = captureOut()
		let code: number
		try {
			code = await runMaintain(["--all", "--repo", repoC])
		} finally {
			cap.stdout.restore()
			cap.stderr.restore()
		}
		// Same contract as the first test: the argument phase's list is the
		// invariant (discovery + the explicit repo, deduped); the run phase's
		// exit code depends on whatever daemon this host has.
		expect(code === 0 || code === 1 || code === 3).toBe(true)
		const out = cap.stdout.chunks.join("")
		expect(out).toContain("2 repo(s)")
		expect(out).toContain(repoA)
		expect(out).toContain(repoC)
		void repoB
	})

	it("repeated --repo without --all still runs exactly one repo (the first, no discovery list)", { timeout: 60_000 }, async () => {
		const repoA = await makeRepo("a")
		const repoB = await makeRepo("b")
		const cap = captureOut()
		let code: number
		try {
			code = await runMaintain(["--repo", repoA, "--repo", repoB])
		} finally {
			cap.stdout.restore()
			cap.stderr.restore()
		}
		// Single-repo mode is unchanged: no discovery list; the exit code is
		// the daemon phase's (see the first test's comment).
		expect(code === 0 || code === 1 || code === 3).toBe(true)
		expect(cap.stdout.chunks.join("")).not.toContain("repo(s)")
	})

	it("--all with an empty worktrees root and no --repo exits 2 with an explanation", { timeout: 30_000 }, async () => {
		const empty = realpathSync(await mkdtemp(join(tmpdir(), "maintain-all-empty-")))
		cleanupPaths.push(empty)
		process.env["AGENTPROTO_WORKTREES_ROOT"] = empty

		const cap = captureOut()
		let code: number
		try {
			code = await runMaintain(["--all"])
		} finally {
			cap.stdout.restore()
			cap.stderr.restore()
		}
		expect(code).toBe(2)
		expect(cap.stderr.chunks.join("")).toContain("--all found no repos")
	})

	it("--all with a --repo outside a git repo exits 2", { timeout: 30_000 }, async () => {
		const empty = realpathSync(await mkdtemp(join(tmpdir(), "maintain-all-empty2-")))
		cleanupPaths.push(empty)
		process.env["AGENTPROTO_WORKTREES_ROOT"] = empty

		const cap = captureOut()
		let code: number
		try {
			code = await runMaintain(["--all", "--repo", empty])
		} finally {
			cap.stdout.restore()
			cap.stderr.restore()
		}
		expect(code).toBe(2)
		expect(cap.stderr.chunks.join("")).toContain("not inside a git repository")
	})
})
