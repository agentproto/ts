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
 *   3. `rm -rf` on the trash dirs runs in ONE DETACHED, serialized deleter
 *      per pool (`ensureTrashDeleter`; a `.trash/.deleting` pid file stops a
 *      second one spawning while it lives) — the parent never waits for the
 *      hundreds of thousands of unlinks, survives its own exit, and a burst
 *      of reclaims doesn't storm the disk with parallel `rm`s. The next `gc` apply also
 *      sweeps stale `.trash` dirs (`sweepWorktreeTrash`) so nothing leaks
 *      even if a child is killed mid-delete.
 *
 * SAFETY — the plain/forced `git worktree remove` semantics this must not
 * weaken, verified empirically against git:
 *   - Plain `git worktree remove` ACCEPTS gitignored files (`node_modules`,
 *     `dist`) and refuses only modified/staged tracked files, unignored
 *     untracked files, dirty submodules and locked worktrees. A non-force
 *     `removeWorktreeFast` gates on `git status --porcelain
 *     --ignore-submodules=none` (no `--ignored`) plus a locked check, and
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
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { rename } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { execArgv, execGit } from "./exec.js"

/** Directory (inside the worktrees root's repo bucket) background-delete leftovers land in. */
export const WORKTREE_TRASH_DIRNAME = ".trash"

/** Pid file (inside a trash dir) of the pool's running background deleter. */
export const WORKTREE_TRASH_PIDFILE = ".deleting"

// One deleter per pool, removing `.trash/*` one dir after another and looping
// until a pass finds nothing (so a dir parked mid-run is still picked up).
// Dotfiles (the pid file) are not matched by `*`. The EXIT trap drops the pid
// file; a killed deleter leaves a stale one, which `isPidAlive` detects.
const DELETER_SCRIPT =
	'trap \'rm -f "$1/.deleting"\' EXIT; n=1; while [ "$n" -gt 0 ]; do n=0; for d in "$1"/*; do [ -e "$d" ] || continue; rm -rf "$d"; n=1; done; done'

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM"
	}
}

function defaultSpawnDeleter(trashParent: string): number | undefined {
	const child = spawn("sh", ["-c", DELETER_SCRIPT, "_", trashParent], { detached: true, stdio: "ignore" })
	child.unref()
	return child.pid
}

/**
 * Make sure ONE detached background deleter is draining `trashParent`
 * (`<pool>/.trash`). Many reclaims in a single gc apply used to each spawn
 * their own `rm -rf` at once, storming the disk; now a live pid in
 * `.deleting` means the running deleter will pick the new dir up, so no
 * second one is spawned. A stale pid file (dead process) is replaced.
 * `spawnDeleter` is the test seam; it returns the spawned child's pid.
 */
export function ensureTrashDeleter(
	trashParent: string,
	spawnDeleter: (trashParent: string) => number | undefined = defaultSpawnDeleter,
): void {
	const pidFile = join(trashParent, WORKTREE_TRASH_PIDFILE)
	try {
		const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10)
		if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) return
	} catch {
		// no pid file — no deleter running
	}
	const pid = spawnDeleter(trashParent)
	if (pid !== undefined) {
		try {
			writeFileSync(pidFile, String(pid))
		} catch {
			// best-effort: worst case a second deleter is spawned next time
		}
	}
}

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
	 * --porcelain --untracked-files=normal --ignore-submodules=none` and refuse (throw) on any dirt — the same refusal a plain
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
	 * Test seam — overrides background deletion per trash dir (e.g. an
	 * in-process spy). Receives the trash dir path. Default: one detached,
	 * serialized deleter per pool (`ensureTrashDeleter`) the parent never
	 * waits on.
	 */
	spawnRemoval?: (trashDir: string) => void
	/**
	 * Test seam — replaces spawning the pool's single serialized background
	 * deleter (see `ensureTrashDeleter`). Receives the `.trash` parent and
	 * returns the spawned pid. Ignored when `spawnRemoval` is set.
	 */
	spawnDeleter?: (trashParent: string) => number | undefined
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

	// Safety gate (1): a non-force removal must refuse exactly what plain
	// `git worktree remove` refuses. Verified against git: it ACCEPTS
	// gitignored files (`node_modules/`, `dist/` — present in every pnpm
	// worktree) and refuses only modified/staged tracked files, unignored
	// untracked files, and dirty submodules. That is precisely a non-empty
	// `git status --porcelain --untracked-files=normal --ignore-submodules=none`
	// (NO `--ignored`; the untracked mode is explicit so a user config of
	// `status.showUntrackedFiles=no` can't hide dirt), so that read is the gate: any output throws before anything moves. (A
	// locked worktree is the other refusal class; gate (2) checks it from the
	// `worktree list` it already reads.)
	if (!force) {
		const status = await execArgv(
			"git",
			["-C", path, "status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none"],
			repoRoot,
		)
		if (status.exitCode !== 0) {
			throw new Error(
				`git status failed in ${path} (exit ${status.exitCode}): ${status.stderr.trim() || status.stdout.trim()}`,
			)
		}
		if (status.stdout.trim().length > 0) {
			throw new Error(
				`git worktree remove failed (exit 128): '${path}' contains modified or untracked files, use --force to delete it`,
			)
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
	// git reports each worktree under its own realpath — a caller passing a
	// symlinked spelling (macOS /tmp → /private/tmp, the default test/tmpdir
	// shape on this host) would never string-match. Compare through realpath
	// on BOTH sides (falling back to the literal path when realpath fails,
	// e.g. a dangling registration); a genuinely-unregistered path still
	// fails here, leaving everything untouched.
	const target = realOrResolved(path)
	let found = false
	let locked = false
	for (const block of list.stdout.split(/\n\s*\n/)) {
		const lines = block.split("\n")
		const head = lines.find((line) => line.startsWith("worktree "))
		if (!head || realOrResolved(head.slice("worktree ".length).trim()) !== target) continue
		found = true
		locked = lines.some((line) => line === "locked" || line.startsWith("locked "))
		break
	}
	if (!found) {
		throw new Error(`not a linked worktree of ${repoRoot}: ${path}`)
	}
	// `git worktree prune` skips locked registrations, so renaming a locked
	// worktree would leave git tracking a missing dir; plain removal refuses it
	// too. Refuse before anything moves.
	if (locked) {
		throw new Error(`git worktree remove failed (exit 128): '${path}' is locked; unlock it first`)
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
		ensureTrashDeleter(dirname(trashDir), options.spawnDeleter)
	}
}

/**
 * Delete every leftover `.trash/*` dir under `root` in the background — the
 * sweep that keeps rename-removal self-cleaning when a detached `rm` child
 * was killed before finishing (or a host rebooted mid-delete). Called at the
 * start of a `gc` apply, where seconds of stale bytes are harmless. Missing
 * root is a no-op, not an error.
 */
export function sweepWorktreeTrash(
	root: string,
	options: { spawnRemoval?: (dir: string) => void; spawnDeleter?: (trashParent: string) => number | undefined } = {},
): void {
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
	names = names.filter((name) => name !== WORKTREE_TRASH_PIDFILE)
	if (names.length === 0) return
	if (options.spawnRemoval) {
		for (const name of names) options.spawnRemoval(join(root, WORKTREE_TRASH_DIRNAME, name))
	} else {
		ensureTrashDeleter(join(root, WORKTREE_TRASH_DIRNAME), options.spawnDeleter)
	}
}
