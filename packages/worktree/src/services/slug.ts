/**
 * Hostname derivation for the `*.localhost` reverse proxy.
 *
 * A service is reachable at:
 *   http://<script>--<branch-slug>--<repo-slug>.localhost:<proxy-port>
 * except on the repo's default branch, where the branch label is dropped:
 *   http://<script>--<repo-slug>.localhost:<proxy-port>
 *
 * `*.localhost` resolves to 127.0.0.1 on modern systems, so no DNS work is
 * needed — the proxy just matches on the Host header.
 */

/** Lowercase, non-alphanumerics → `-`, collapse repeats, trim leading/trailing `-`. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export interface HostnameParts {
  /** The script/service name (e.g. `"web"`). */
  script: string
  /** The worktree's branch (e.g. `"wt/fix-flaky"`). */
  branch: string
  /** The repo identifier (e.g. its directory basename). */
  repo: string
  /** True when `branch` is the repo's default branch — drops the branch label. */
  isDefaultBranch: boolean
}

/** The bare hostname (no scheme, no port) a service is proxied under. */
export function serviceHostname(parts: HostnameParts): string {
  const labels = parts.isDefaultBranch
    ? [slugify(parts.script), slugify(parts.repo)]
    : [slugify(parts.script), slugify(parts.branch), slugify(parts.repo)]
  return `${labels.join("--")}.localhost`
}

/** The full proxy URL (`http://<hostname>:<proxy-port>`) for a service. */
export function serviceUrl(parts: HostnameParts, proxyPort: number): string {
  return `http://${serviceHostname(parts)}:${proxyPort}`
}
