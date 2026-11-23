/**
 * Repo resolution for repo maintenance, shared by `agentproto maintain --all`
 * (CLI) and the daemon's `maintain_run` tool: one source of truth for WHICH
 * repos a maintenance pass covers and for the run defaults read from the
 * user config's `maintain` section (`~/.agentproto/config.json`).
 *
 * Lives in `@agentproto/runtime` because the config schema and `loadConfig`
 * live here: the CLI already imports `@agentproto/runtime/config`, and the
 * daemon tool needs it in-process. The module itself is light, Node built-ins
 * plus the config schema, no daemon machinery; it is exported on its own
 * subpath (`@agentproto/runtime/maintain-repos`) so the CLI does not load the
 * runtime's root entry for it.
 *
 * Discovery: the worktrees root is laid out `<root>/<repoDir>/<slug>`, every
 * `<slug>` a linked git worktree whose `.git` is a FILE
 * (`gitdir: <main>/.git/worktrees/<name>`). Reading that pointer is the whole
 * fact needed, no `git` spawn: a dir with no `.git`, or a `.git` DIRECTORY (a
 * main checkout dropped inside the root), is skipped, not guessed at.
 */

import { spawnSync } from "node:child_process"
import { readdir, readFile, stat, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { AgentprotoConfig, MaintainConfig, MaintainNotifyConfig } from "./config.js"
import { maintainConfigSchema } from "./config-schema.js"

/** Expand a leading `~` / `~/` and resolve to an absolute path. */
function expandHome(raw: string, home: string): string {
	return resolve(raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : raw)
}

/**
 * Normalise a list of extra worktrees roots (from `worktrees.extraRoots` and
 * `--worktrees-root`): `~/` expands, everything resolves to an absolute path,
 * blanks are dropped and duplicates collapse, first occurrence wins.
 */
export function normalizeExtraRoots(raw: readonly string[] | undefined, home: string = homedir()): string[] {
	const out: string[] = []
	for (const entry of raw ?? []) {
		const trimmed = entry.trim()
		if (!trimmed) continue
		const abs = expandHome(trimmed, home)
		if (!out.includes(abs)) out.push(abs)
	}
	return out
}

/**
 * The configured worktrees root, same order as the CLI's
 * `resolveWorktreesRoot`: `AGENTPROTO_WORKTREES_ROOT` env > config
 * `worktrees.root` > `~/.agentproto/worktrees`.
 */
export function configuredWorktreesRoot(
	config: AgentprotoConfig | undefined,
	opts: { env?: NodeJS.ProcessEnv; home?: string } = {},
): string {
	const env = opts.env ?? process.env
	const home = opts.home ?? homedir()
	const fromEnv = env["AGENTPROTO_WORKTREES_ROOT"]
	if (fromEnv) return resolve(fromEnv)
	if (config?.worktrees?.root) return expandHome(config.worktrees.root, home)
	return join(home, ".agentproto", "worktrees")
}

/**
 * Discover the main repos behind every worktree under `root`:
 * for each `<root>/<repoDir>/<slug>` whose `.git` is a FILE, read
 * `gitdir: <main>/.git/worktrees/<name>` and take `<main>`. Deduped,
 * realpath'd, sorted for stable output. A missing/unreadable `root` yields
 * an empty list, not an error.
 */
export async function discoverWorktreeOwningRepos(root: string): Promise<string[]> {
	const buckets = await readdir(root, { withFileTypes: true }).catch(() => [])
	const mains = new Set<string>()
	for (const bucket of buckets) {
		if (!bucket.isDirectory()) continue
		const bucketDir = join(root, bucket.name)
		// A worktree sitting directly at the root (`<root>/<slug>`, a hand-made
		// pool or a repo's sibling `*-wt-*` dirs) is its own entry, not a bucket.
		const direct = await mainRepoOfWorktree(bucketDir)
		if (direct) {
			mains.add(direct)
			continue
		}
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
		if (!st.isFile()) return null
		raw = await readFile(join(worktreePath, ".git"), "utf8")
	} catch {
		return null
	}
	const pointer = raw.match(/^gitdir:\s*(.+?)\s*$/m)?.[1]
	if (!pointer) return null
	// `gitdir: <main>/.git/worktrees/<name>` -> `<main>` = dirname x3. The
	// realpath folds macOS's `/tmp` -> `/private/tmp` so discovered roots
	// compare equal to explicitly named ones.
	const main = resolve(resolve(worktreePath, pointer), "..", "..", "..")
	try {
		return await realpath(main)
	} catch {
		return null
	}
}

async function realpathOr(path: string): Promise<string> {
	try {
		return await realpath(path)
	} catch {
		return resolve(path)
	}
}

/**
 * Every discovered main repo under the given roots, plus explicit repo roots
 * (already resolved to main toplevels by the caller), deduped by realpath:
 * discovery first (sorted), then explicit ones in the order given.
 */
export async function resolveAllRepos(
	root: string | readonly string[],
	explicitRepos: readonly string[] = [],
): Promise<string[]> {
	const roots = typeof root === "string" ? [root] : root
	const discovered = [...new Set((await Promise.all(roots.map(discoverWorktreeOwningRepos))).flat())].sort()
	const all = new Set<string>()
	for (const repo of [...discovered, ...explicitRepos]) all.add(await realpathOr(repo))
	return [...all]
}

/**
 * The MAIN repo root of any dir inside a git repo (a linked worktree maps to
 * its main checkout, the root maintain works on), or `null` outside one.
 * `--path-format=absolute` keeps `--git-common-dir` absolute even from the
 * main worktree itself.
 */
export function mainRepoRootOf(dir: string): string | null {
	const res = spawnSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
		encoding: "utf8",
	})
	if (res.status !== 0) return null
	const gitDir = res.stdout.trim()
	return gitDir ? resolve(dirname(gitDir)) : null
}

/**
 * The config's `maintain` section, validated with the same schema
 * `config_set` uses. `loadConfig` itself does not validate, so a hand-edited
 * typo surfaces here, loudly, instead of silently maintaining the wrong set.
 */
export function readMaintainConfig(config: AgentprotoConfig | undefined): MaintainConfig {
	const raw = config?.maintain
	if (raw === undefined) return {}
	const parsed = maintainConfigSchema.safeParse(raw)
	if (!parsed.success) {
		const issues = parsed.error.issues.map(i => `maintain.${i.path.join(".")}: ${i.message}`)
		throw new Error(`invalid \`maintain\` config: ${issues.join("; ")}`)
	}
	return parsed.data
}

export interface ResolveMaintainReposExtra {
	/** Worktrees root to scan; default {@link configuredWorktreesRoot}. */
	worktreesRoot?: string
	/** Extra roots to scan on top of config `worktrees.extraRoots`
	 *  (the CLI's `--worktrees-root`). Scanned even with `discover: false`:
	 *  naming a root is an explicit ask. */
	extraRoots?: readonly string[]
	/** Explicitly requested repos (CLI `--repo`, tool `repos`): any dir in a
	 *  repo, added on top and NOT filtered by `maintain.exclude`. */
	repos?: readonly string[]
	/** Dir -> main repo root; default {@link mainRepoRootOf}. */
	resolveRepoRoot?: (dir: string) => string | null
	env?: NodeJS.ProcessEnv
	home?: string
}

export interface ResolvedMaintainRepos {
	/** Repos to maintain, realpath'd main roots, deduped, stable order:
	 *  discovered (sorted), then `maintain.repos`, then explicit ones. */
	repos: string[]
	/** Entries that could not be used, with the reason (not in a git repo). */
	skipped: Array<{ path: string; source: "config" | "explicit" | "exclude"; reason: string }>
	/** Repos removed by `maintain.exclude`. */
	excluded: string[]
	/** The roots that were scanned (empty when nothing was discovered). */
	scannedRoots: string[]
}

/**
 * The repo list of a `maintain --all` / `maintain_run {all:true}` pass:
 * `(maintain.discover !== false ? repos owning a worktree under
 * worktrees.root + worktrees.extraRoots : none)` + extra scanned roots +
 * `maintain.repos`, minus `maintain.exclude`, plus the explicit repos.
 * Every entry is normalised to the realpath of its main repo root, so a dir
 * inside a repo, a worktree of it and the repo itself all name one repo.
 * Throws on an invalid `maintain` section (see {@link readMaintainConfig}).
 */
export async function resolveMaintainRepos(
	config: AgentprotoConfig | undefined,
	extra: ResolveMaintainReposExtra = {},
): Promise<ResolvedMaintainRepos> {
	const maintain = readMaintainConfig(config)
	const home = extra.home ?? homedir()
	const toRoot = extra.resolveRepoRoot ?? mainRepoRootOf
	const skipped: ResolvedMaintainRepos["skipped"] = []

	const normalize = async (raw: string, source: "config" | "explicit" | "exclude"): Promise<string | null> => {
		const abs = expandHome(raw.trim(), home)
		const root = toRoot(abs)
		if (!root) {
			skipped.push({ path: abs, source, reason: "not inside a git repository" })
			return null
		}
		return realpathOr(root)
	}

	const scannedRoots =
		maintain.discover === false
			? normalizeExtraRoots(extra.extraRoots, home)
			: normalizeExtraRoots(
					[
						extra.worktreesRoot ?? configuredWorktreesRoot(config, { ...(extra.env ? { env: extra.env } : {}), home }),
						...(config?.worktrees?.extraRoots ?? []),
						...(extra.extraRoots ?? []),
					],
					home,
				)
	const discovered = await resolveAllRepos(scannedRoots)

	const configured: string[] = []
	for (const raw of maintain.repos ?? []) {
		const root = await normalize(raw, "config")
		if (root) configured.push(root)
	}
	const excludedSet = new Set<string>()
	for (const raw of maintain.exclude ?? []) {
		const abs = expandHome(raw.trim(), home)
		// An excluded repo may be gone or moved: fall back to its realpath so
		// a stale entry never fails the pass (it just matches nothing).
		const root = toRoot(abs)
		excludedSet.add(await realpathOr(root ?? abs))
	}
	const explicit: string[] = []
	for (const raw of extra.repos ?? []) {
		const root = await normalize(raw, "explicit")
		if (root) explicit.push(root)
	}

	const out: string[] = []
	const excluded: string[] = []
	for (const repo of [...discovered, ...configured]) {
		if (excludedSet.has(repo)) {
			if (!excluded.includes(repo)) excluded.push(repo)
			continue
		}
		if (!out.includes(repo)) out.push(repo)
	}
	for (const repo of explicit) if (!out.includes(repo)) out.push(repo)
	return { repos: out, skipped, excluded, scannedRoots }
}

/** Per-run options a caller (CLI flags, `maintain_run` inputs) may set. */
export interface MaintainRunOptions {
	applyMerged?: boolean
	applyReviewed?: boolean
	requireOperatorBelowGuard?: boolean
	maxReviews?: number
	reviewPreset?: string
	notify?: MaintainNotifyConfig
}

/**
 * The `maintain` workflow's `input` for one repo: the caller's options win,
 * then `maintain.maxReviews` / `reviewPreset` / `notify` from the config,
 * then the workflow's own defaults (the key is left out).
 */
export function maintainWorkflowInput(
	repo: string,
	opts: MaintainRunOptions,
	maintain: MaintainConfig = {},
): Record<string, unknown> {
	const maxReviews = opts.maxReviews ?? maintain.maxReviews
	const reviewPreset = opts.reviewPreset ?? maintain.reviewPreset
	const notify = opts.notify ?? maintain.notify
	return {
		repoRoot: repo,
		applyMerged: opts.applyMerged === true,
		applyReviewed: opts.applyReviewed === true,
		...(opts.requireOperatorBelowGuard === true ? { requireOperatorBelowGuard: true } : {}),
		...(reviewPreset !== undefined ? { reviewPreset } : {}),
		...(maxReviews !== undefined ? { maxReviews } : {}),
		...(notify !== undefined ? { notify } : {}),
	}
}
