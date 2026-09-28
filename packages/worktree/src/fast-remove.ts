/**
 * Fast worktree removal: `rename` to a same-volume trash dir + `git worktree
 * prune`, with the bytes deleted by a detached background child.
 *
 * WHY THIS EXISTS: `git worktree remove` deletes the worktree tree in
 * process, one file at a time — on a pnpm worktree (its own `node_modules` /
 * `.pnpm-vstores`, hundreds of thousands of files) on an external SSD that
 * measured ~10 minutes PER WORKTREE. Every part of the removal that callers
 * actually wait on is instant:
 *
 *   1. `rename` the worktree directory to `<dirname(path)>/.trash/<base>-
 *      <timestamp>` — same volume by construction, so it's a metadata
 *      operation, not a copy. `git worktree remove`'s per-file refusals have
 *      already run (see `removeWorktreeFast`), so at this point the bytes
 *      are authorized to die; only the cost is being moved.
 *   2. `git worktree prune` — git forgets the (now missing) registration.
 *      The worktree disappears from `git worktree list` immediately.
 *   3. `rm -rf` on the trash dir runs in a DETACHED child
 *      (`spawn("rm", ["-rf", trashDir], { detached: true, stdio: "ignore" })`
 *      + `.unref()`) — the parent never waits for the hundreds of thousands
 *      of unlinks, and survives its own exit. The next `gc` apply also
 *      sweeps stale `.trash` dirs (`sweepWorktreeTrash`) so nothing leaks
 *      even if a child is killed mid-delete.
 *
 * SAFETY — the plain/forced `git worktree remove` semantics this must not
 * weaken, verified empirically against git (see the brief):
 *   - A non-force removal must refuse a dirty tree: the caller passes
 *     `force: false` only for a tree already checked clean, and
 *     `removeWorktreeFast` re-checks `git status --porcelain` itself and
 *     throws (leaving the worktree in place) rather than renaming dirt away.
 *   - A forced removal is only ever passed after a salvage snapshot or an
 *     explicit user-granted discard flag upstream — this module doesn't
 *     loosen that; it just performs the same destruction instantly.
 *
 * Fallback: if the `rename` fails for any reason (cross-device, permissions,
 * the trash parent unmountable), the function falls back to today's plain
 * `git worktree remove [--force]` — behavior identical to before, just slow.
 */

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs"
import { rename } from "node:fs/promises"
import { basename, join } from "node:path"
import { execArgv, execGit } from "./exec.js"

/** Directory (inside the worktrees root's repo bucket) background-delete leftovers land in. */
export const WORKTREE_TRASH_DIRNAME = ".trash"

/**
 * `realpath`, falling back to the input for a path that doesn't exist —
 * mirrors gc.ts's `realOrResolved` convention (git reports worktree paths
 * realpath'd; callers may pass a symlinked spelling like macOS `/tmp`).
 */
function realOrResolved(path: string): string {
	try {
		return realpathSync(path)
	} catch {
		return path
	}
}

export interface RemoveWorktreeFastOptions {
	/**
	 * `false` (default): re-verify the tree is clean via `git status
	 * --porcelain` and refuse (throw) on any dirt — the same refusal a plain
	 * `git worktree remove` performs. `true`: skip the cleanliness gate,
	 * exactly like `git worktree remove --force` — only pass this when dirt
	 * has been authorized (salvage snapshot durable / discard flags granted)
	 * upstream.
	 */
	force?: boolean
	/**
	 * Injectable clock for the trash dir's timestamp suffix — tests freeze it
	 * so the dir name is deterministic. Defaults to `Date.now`.
	 */
	now?: () => number
	/**
	 * Test seam — overrides the detached `rm -rf` child (e.g. an in-process
	 * spy). Receives the trash dir path. Default: a detached
	 * `spawn("rm", ["-rf", …])` the parent never waits on.
	 */
	spawnRemoval?: (trashDir: string) => void
}

/**
 * Remove a linked git worktree instantly: validate → rename to trash →
 * prune → delete the trash in the background. Throws the same *shape* of
 * error `execGit` would on refusal (message carries git's own stderr where
 * git produced one) so callers' existing error handling keeps working.
 */
export async function removeWorktreeFast(
	repoRoot: string,
	path: string,
	options: RemoveWorktreeFastOptions = {},
): Promise<void> {
	const force = options.force === true

	// Safety gate (1): a non-force removal must refuse a dirty tree, exactly
	// like `git worktree remove` without `--force`, whose arbiter is git's
	// own refusal rules — so the gate re-derives git's verdict without
	// mutating anything (there is no `worktree remove --dry-run` flag):
	//
	//   a. the registration check below;
	//   b. `git status --porcelain=v2 --ignored=matching` in the worktree —
	//      ANY output at all refuses. That one probe reproduces the exact
	//      tolerance table git's non-force removal enforces, verified
	//      empirically against this repo's own git: modified/staged/unignored
	//      dirt (`1`/`2`/`?`/`u` records) refuses it, and — the case a
	//      plain `--porcelain` cannot see — gitignored files refuse it too
	//      (`!` records), which is why git's plain removal of a
	//      gitignore-only tree errors out even though `status --porcelain`
	//      reads empty;
	//   c. submodule dirt: git plain-refuses a tree with modified submodule
	//      content, which a `!`/`?`-free porcelain read would miss — a
	//      read-only `worktree remove` probe catches that residual class,
	//      and only that class, by its 128 exit with the dir still intact.
	//
	// A refused probe throws before anything moves; a passing one is the
	// tree git itself certifies removable, which is the moment the rename
	// is safe to be instant.
	if (!force) {
		const status = await execArgv(
			"git",
			["-C", path, "status", "--porcelain=v2", "--ignored=matching"],
			repoRoot,
		)
		if (status.exitCode !== 0) {
			throw new Error(
				`git status failed in ${path} (exit ${status.exitCode}): ${status.stderr.trim() || status.stdout.trim()}`,
			)
		}
		if (status.stdout.trim().length > 0) {
			const probe = await execArgv("git", ["-C", repoRoot, "worktree", "remove", path], repoRoot)
			if (probe.exitCode !== 0) {
				// Git's own refusal (the common case: real dirt). Nothing moved.
				throw new Error(
					`git worktree remove failed (exit ${probe.exitCode}): ${probe.stderr.trim() || probe.stdout.trim()}`,
				)
			}
			// The status read saw dirt the removal tolerates (a gitignored path
			// that a `.gitignore` in the worktree shadows differently than in
			// the main repo, etc.) — git itself just removed the worktree, so
			// there is nothing left to rename; fall back to the old path's
			// final steps (branch handling stays the caller's).
			await execGit(repoRoot, ["worktree", "prune"])
			return
		}
	}

	// Safety gate (2): the path must actually be a linked worktree of
	// `repoRoot` before we rename anything — a stale/duplicate call must fail
	// loudly here, not leave git's registration pointing at a renamed dir it
	// still tracks.
	const list = await execArgv("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], repoRoot)
	if (list.exitCode !== 0) {
		throw new Error(
			`git worktree list failed (exit ${list.exitCode}): ${list.stderr.trim() || list.stdout.trim()}`,
		)
	}
	const registered = new Set(
		list.stdout
			.split("\n")
			.filter((line) => line.startsWith("worktree "))
			.map((line) => line.slice("worktree ".length).trim()),
	)
	// git reports each worktree under its own realpath — a caller passing a
	// symlinked spelling (macOS /tmp → /private/tmp, the default test/tmpdir
	// shape on this host) would never string-match. Compare through realpath
	// on BOTH sides (falling back to the literal path when realpath fails,
	// e.g. a dangling registration); a genuinely-unregistered path still
	// fails here, leaving everything untouched.
	const registeredReal = new Set([...registered].map(realOrResolved))
	if (!registeredReal.has(realOrResolved(path))) {
		throw new Error(`not a linked worktree of ${repoRoot}: ${path}`)
	}

	// Fast path: rename to a same-volume trash dir (instant, even for
	// hundreds of thousands of files), prune the registration, hand the
	// bytes to a detached background child.
	const poolDir = join(path, "..")
	const stamp = (options.now ?? Date.now)()
	const trashDir = join(poolDir, WORKTREE_TRASH_DIRNAME, `${basename(path)}-${stamp}`)
	try {
		// The trash parent may not exist yet (first removal in this pool) —
		// `rename` gives ENOENT rather than creating it. `mkdirSync` is
		// idempotent and instant; a failure here (or in `rename` below) falls
		// back to the plain removal.
		if (!existsSync(join(poolDir, WORKTREE_TRASH_DIRNAME))) {
			mkdirSync(join(poolDir, WORKTREE_TRASH_DIRNAME))
		}
		await rename(path, trashDir)
	} catch {
		// Fallback (cross-device link, permission, trash parent unmountable…):
		// today's slow, plain removal — behavior identical to before.
		await execGit(repoRoot, force ? ["worktree", "remove", "--force", path] : ["worktree", "remove", path])
		return
	}
	await execGit(repoRoot, ["worktree", "prune"])

	// Background deletion: detached so the parent (and its event loop) never
	// waits for the unlinks; `.unref()` so the parent can exit first.
	if (options.spawnRemoval) {
		options.spawnRemoval(trashDir)
	} else {
		spawn("rm", ["-rf", trashDir], { detached: true, stdio: "ignore" }).unref()
	}
}

/**
 * Delete every leftover `.trash/*` dir under `root` in the background — the
 * sweep that keeps rename-removal self-cleaning when a detached `rm` child
 * was killed before finishing (or a host rebooted mid-delete). Called at the
 * start of a `gc` apply, where seconds of stale bytes are harmless. Missing
 * root is a no-op, not an error.
 */
export function sweepWorktreeTrash(root: string, options: { spawnRemoval?: (dir: string) => void } = {}): void {
	// Sync read is deliberate: the caller (gc apply) wants to fire the sweep
	// and move on in the same tick, without awaiting an async dependency
	// chain just to list a directory. A missing/unreadable trash dir means
	// "nothing swept", not an error.
	let names: string[]
	try {
		names = readdirSync(join(root, WORKTREE_TRASH_DIRNAME))
	} catch {
		return
	}
	for (const name of names) {
		const trashDir = join(root, WORKTREE_TRASH_DIRNAME, name)
		if (options.spawnRemoval) {
			options.spawnRemoval(trashDir)
		} else {
			spawn("rm", ["-rf", trashDir], { detached: true, stdio: "ignore" }).unref()
		}
	}
}
