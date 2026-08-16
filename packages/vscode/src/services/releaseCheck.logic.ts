/**
 * Pure release-check logic — NO vscode import and no I/O, so the interesting
 * decisions (is a new `@agentproto/cli` release out, and what does it mean for
 * THIS daemon) are unit-testable without a network, a home dir, or the
 * extension host. The IO layer lives in releaseCheck.ts (npm fetch + the
 * `~/.agentproto/release-check.json` cache); this module only decides.
 *
 * Contract (from .plans/release-update-indicator-PLAN.md, WP-A):
 *  - The signal "a new release exists" is the npm registry for
 *    `@agentproto/cli` (the CLI carries the daemon; `health.version` IS the CLI
 *    version, so the daemon inherits it).
 *  - Two comparison modes by `build.source` read on DaemonClient.health():
 *      - `tarball` / absent → compare `health.version` against npm latest.
 *      - `workspace` → signal `workspace` distinctly: the real update for a
 *        workspace install is a local REBUILD, not an npm reinstall, so the
 *        status bar must not pretend a plain "update available" means anything.
 *  - Offline-safe: never claim an update we didn't verify. When the npm fetch
 *    failed and the cache is stale, the answer is `unknown` — never a false
 *    "update dispo" off a stale number.
 */

/** Cache file version — bump when the on-disk shape changes. */
export const RELEASE_CHECK_CACHE_VERSION = 1

/** Default npm poll TTL (ms). ~1 h, never below the 10 min floor. */
export const RELEASE_CHECK_DEFAULT_TTL_MS = 60 * 60 * 1000
export const RELEASE_CHECK_MIN_TTL_MS = 10 * 60 * 1000

/** Build provenance, from DaemonHealth.build.source. */
export type ReleaseBuildSource = "workspace" | "tarball" | null

/**
 * What the release indicator reports. `workspace` is deliberately distinct
 * from `current`: both mean "nothing to install via npm", but `workspace`
 * additionally tells the display to frame the update as a rebuild.
 */
export type ReleaseState = "current" | "behind" | "unknown" | "workspace"

/** Persistent cache — the offline fallback. Versioned like the other
 *  `~/.agentproto/*.json` stores (`{ version: N, ... }`). */
export interface ReleaseCheckCache {
  /** Cache-file shape version. Must equal RELEASE_CHECK_CACHE_VERSION to be
   *  trusted; a mismatch (older/newer on-disk shape) is treated as no cache. */
  version: number
  /** Latest `@agentproto/cli` observed on npm. Null while unknown. */
  latest: string | null
  /** Local CLI version at the time of the check that produced `latest`. */
  localVersion: string | null
  /** Epoch ms of the last successful npm fetch. */
  checkedAtMs: number
}

/**
 * Compare two dotted versions numerically. Returns a positive integer when
 * `a > b`, negative when `a < b`, 0 when equal or unparseable. Accepts
 * optional `v` prefix and trailing prerelease/build suffix.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { parts: number[]; ok: boolean } => {
    const parts =
      v
        .replace(/^v/i, "")
        .split("-")[0]
        ?.split(".")
        .map(Number)
        .filter(n => Number.isFinite(n)) ?? []
    // A version that yields no numeric component (e.g. "abc") can't be
    // compared — treat the whole comparison as inconclusive rather than guess.
    return { parts, ok: parts.length > 0 }
  }
  const pa = parse(a)
  const pb = parse(b)
  if (!pa.ok || !pb.ok) return 0
  const len = Math.max(pa.parts.length, pb.parts.length)
  for (let i = 0; i < len; i++) {
    const da = pa.parts[i] ?? 0
    const db = pb.parts[i] ?? 0
    if (da !== db) return da - db
  }
  return 0
}

/**
 * The WP-A decision. Returns:
 *  - `unknown`   — no usable `latestVersion` (network error / no cache → the
 *                  offline-safe answer; never a fabricated "behind").
 *  - `workspace` — the daemon is served from a workspace build: the real
 *                  update is a rebuild, so this is its own state, not a
 *                  plain `behind`.
 *  - `behind`    — `buildSource` is a published tarball and npm is ahead.
 *  - `current`   — tarball and npm is not ahead.
 */
export function compareRelease(
  localVersion: string | null | undefined,
  latestVersion: string | null | undefined,
  buildSource: ReleaseBuildSource,
): ReleaseState {
  if (!localVersion || !latestVersion) return "unknown"
  if (buildSource === "workspace") return "workspace"
  if (compareVersions(latestVersion, localVersion) > 0) return "behind"
  return "current"
}

/** TTL, clamped to the 10 min floor. */
export function releaseTtlMs(intervalMin: number | undefined): number {
  const min = intervalMin && intervalMin > 0 ? intervalMin : RELEASE_CHECK_DEFAULT_TTL_MS / 60_000
  return Math.max(min * 60_000, RELEASE_CHECK_MIN_TTL_MS)
}

/** True when the cache is young enough to trust without a fresh fetch. */
export function isCacheFresh(
  cache: ReleaseCheckCache | null,
  nowMs: number,
  ttlMs: number,
): boolean {
  if (!cache || cache.version !== RELEASE_CHECK_CACHE_VERSION) return false
  if (typeof cache.checkedAtMs !== "number" || Number.isNaN(cache.checkedAtMs)) return false
  return nowMs - cache.checkedAtMs <= ttlMs
}

export interface ResolveCheckInput {
  localVersion: string | null
  buildSource: ReleaseBuildSource
  /** Npm result from a fresh fetch. Null when the network fetch failed or was
   *  skipped because the cache was already fresh. */
  latestFromNpm: string | null
  cache: ReleaseCheckCache | null
  nowMs: number
  ttlMs: number
}

export interface ResolveCheckResult {
  state: ReleaseState
  /** The `@agentproto/cli` latest we trust, if any (fresh npm or fresh cache). */
  latest: string | null
  /** Whether `latest` came from the cache rather than a live fetch. */
  fromCache: boolean
  /** Cached latest (may be stale) — informational only, never drives state. */
  cachedLatest: string | null
}

/**
 * Resolve the full check from its inputs. This is the pure, offline-safe
 * core: a fresh npm result wins; otherwise a fresh cache is trusted (this is
 * the "return the cache if the TTL hasn't expired" fallback); otherwise the
 * answer is `unknown` — a stale cache never fabricates a "behind".
 */
export function resolveReleaseCheck(input: ResolveCheckInput): ResolveCheckResult {
  const freshCache = isCacheFresh(input.cache, input.nowMs, input.ttlMs)
  if (input.latestFromNpm) {
    return {
      state: compareRelease(input.localVersion, input.latestFromNpm, input.buildSource),
      latest: input.latestFromNpm,
      fromCache: false,
      cachedLatest: input.cache?.latest ?? null,
    }
  }
  if (freshCache && input.cache?.latest) {
    return {
      state: compareRelease(input.localVersion, input.cache.latest, input.buildSource),
      latest: input.cache.latest,
      fromCache: true,
      cachedLatest: input.cache.latest,
    }
  }
  // Network failed AND the cache is stale or absent → unknown, no false claim.
  return {
    state: "unknown",
    latest: null,
    fromCache: false,
    cachedLatest: input.cache?.latest ?? null,
  }
}