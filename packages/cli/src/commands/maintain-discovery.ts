/**
 * `--all` discovery for `agentproto maintain`. The logic moved to
 * `@agentproto/runtime/maintain-repos` so the daemon's `maintain_run` tool
 * resolves the exact same repo set; this module re-exports it for the CLI's
 * existing callers and tests.
 */

export {
	discoverWorktreeOwningRepos,
	mainRepoOfWorktree,
	normalizeExtraRoots,
	resolveAllRepos,
} from "@agentproto/runtime/maintain-repos"
