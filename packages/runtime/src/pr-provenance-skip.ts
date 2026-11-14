/**
 * The one place `defaults.prProvenance.footer.skipRepos` is interpreted.
 *
 * Every daemon lane that can put a provenance footer on a PR (the turn-end
 * reconciler, the `command_execute` stamper and the sandbox `pr_open` path)
 * asks this module whether a repo opted out, and the `gh` PATH shim receives
 * the same list through its env (see `gh-provenance-shim.ts`). Keeping the
 * repo extraction and the case-insensitive comparison here means the lanes
 * cannot drift from one another.
 */

/** Where the per-repo opt-out list lives in `~/.agentproto/config.json`. */
export interface FooterSkipConfig {
  defaults?: {
    prProvenance?: {
      footer?: {
        skipRepos?: readonly string[]
      }
    }
  }
}

/** `owner/name` of a forge PR url (`https://host/owner/name/pull/42`), or
 *  undefined when the url does not have that shape. */
export function repoFromPrUrl(url: string): string | undefined {
  return /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url)?.[1]
}

/** Trim and lowercase a repo identity so `Acme/Widgets` matches
 *  `acme/widgets` (GitHub owners and repos are case-insensitive). */
export function normalizeRepo(repo: string): string {
  return repo.trim().toLowerCase()
}

/** Whether `prUrl` names a repo in `skipRepos`, comparing case-insensitively. */
export function isFooterSkipped(prUrl: string, skipRepos: readonly string[]): boolean {
  const repo = repoFromPrUrl(prUrl)
  if (repo === undefined) return false
  const needle = normalizeRepo(repo)
  return skipRepos.some(entry => normalizeRepo(entry) === needle)
}

/** Resolve a per-call skip-list source, swallowing an unreadable config into
 *  an empty list (stamping stays on by default). */
export async function resolveFooterSkipRepos(
  source?: () => Promise<readonly string[]> | readonly string[],
): Promise<readonly string[]> {
  if (!source) return []
  try {
    return await source()
  } catch {
    return []
  }
}

/**
 * Read the opt-out list from config. Called per stamp (or per spawn for the
 * `gh` shim), so a config edit takes effect without a daemon restart. A
 * missing/malformed config or a non-array value yields an empty list.
 */
export async function loadFooterSkipRepos(
  loadCfg: () => Promise<FooterSkipConfig> = defaultLoadConfig,
): Promise<readonly string[]> {
  try {
    const cfg = await loadCfg()
    const list = cfg.defaults?.prProvenance?.footer?.skipRepos
    if (!Array.isArray(list)) return []
    return list.filter((entry): entry is string => typeof entry === "string")
  } catch {
    return []
  }
}

/** Lazy import keeps this module importable by tests without pulling the
 *  config reader (and its import graph) in at module load. */
async function defaultLoadConfig(): Promise<FooterSkipConfig> {
  const { loadConfig } = await import("./config.js")
  return loadConfig()
}
