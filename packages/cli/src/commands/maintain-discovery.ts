/**
 * `--all` discovery for `agentproto maintain` — find every MAIN repo that
 * owns a worktree under the worktrees root.
 *
 * The worktrees root (`resolveWorktreesRoot`, commands/worktree.ts) is laid
 * out `<root>/<repoDir>/<slug>`: every `<slug>` entry is a linked git
 * worktree whose `.git` is a FILE (`gitdir: <main>/.git/worktrees/<name>`),
 * and `<repoDir>` is a bucket named after whichever repo provisioned it.
 * `maintain` runs per repo, so nothing ever cleaned the other five repos'
 * buckets — `--all` walks the whole root once and returns the deduped set
 * of owning main repos.
 *
 * Deliberately file-based, no `git` spawns: reading the `.git` pointer is
 * the whole fact needed (a bucket dir that isn't a worktree pool, a plain
 * dir with no `.git`, or one whose `.git` is a directory — a main checkout
 * dropped inside the root — is skipped, not guessed at). Repos given with
 * repeated `--repo` are appended by the caller and deduped here, so an
 * explicitly-named repo is maintained even when it owns no worktree yet.
 */

import { readdir, readFile, stat, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"

/**
 * Discover the main repos behind every worktree under `root`:
 * for each `<root>/<repoDir>/<slug>` whose `.git` is a FILE, read
 * `gitdir: <main>/.git/worktrees/<name>` and take `<main>`. Deduped,
 * realpath'd, sorted for stable output. A `<repoDir>` with no readable
 * worktrees under it (or entries that aren't linked worktrees) contributes
 * nothing; a missing/unreadable `root` yields an empty list, not an error.
 */
export async function discoverWorktreeOwningRepos(root: string): Promise<string[]> {
	const buckets = await readdir(root, { withFileTypes: true }).catch(() => [])
	const mains = new Set<string>()
	for (const bucket of buckets) {
		if (!bucket.isDirectory()) continue
		const bucketDir = join(root, bucket.name)
		const entries = await readdir(bucketDir, { withFileTypes: true }).catch(() => [])
		for (const entry of entries) {
			if (!entry.isDirectory()) continue
			const main = await mainRepoOfWorktree(join(bucketDir, entry.name))
			if (main) mains.add(main)
		}
	}
	return [...mains].sort()
}

/**
 * The main repo root of a linked worktree directory, or `null` when this
 * directory isn't one: no `.git`, a `.git` DIRECTORY (a main checkout, not
 * a linked worktree), or an unparseable/unresolvable `gitdir:` pointer.
 */
export async function mainRepoOfWorktree(worktreePath: string): Promise<string | null> {
	let raw: string
	try {
		const st = await stat(join(worktreePath, ".git"))
		// A linked worktree's `.git` is a FILE holding the gitdir pointer; a
		// directory means this IS a main checkout — exactly what `--all` must
		// not adopt (it would maintain the wrong root, or itself).
		if (!st.isFile()) return null
		raw = await readFile(join(worktreePath, ".git"), "utf8")
	} catch {
		return null
	}
	const match = raw.match(/^gitdir:\s*(.+?)\s*$/m)
	const pointer = match?.[1]
	if (!pointer) return null
	// `gitdir: <main>/.git/worktrees/<name>` → `<main>` = dirname×3. The
	// pointer is usually absolute; resolve so a relative one still works.
	// The realpath also folds macOS's `/tmp` → `/private/tmp` spelling so
	// discovered roots compare equal to explicit `--repo` roots (which the
	// CLI resolves through `repoRootOf`'s `--git-common-dir`).
	const gitDir = resolve(worktreePath, pointer)
	const main = resolve(gitDir, "..", "..", "..")
	try {
		return await realpath(main)
	} catch {
		return null
	}
}

/**
 * The full `--all` repo list: every discovered main repo under the
 * worktrees root, plus any explicitly-passed `--repo` roots (already
 * resolved to git toplevels by the caller via `repoRootOf`), deduped by
 * realpath, discovery first (sorted) then explicit ones in the order given.
 * Purely additive: a repo with no worktrees still runs when named.
 */
export async function resolveAllRepos(
	root: string,
	explicitRepos: readonly string[] = [],
): Promise<string[]> {
	const discovered = await discoverWorktreeOwningRepos(root)
	const all = new Set<string>()
	for (const repo of discovered) {
		try {
			all.add(await realpath(repo))
		} catch {
			all.add(repo)
		}
	}
	for (const repo of explicitRepos) {
		try {
			all.add(await realpath(repo))
		} catch {
			all.add(resolve(repo))
		}
	}
	return [...all]
}
