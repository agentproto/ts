/**
 * IO layer for the release check — npm fetch + the versioned offline cache at
 * `~/.agentproto/release-check.json`. All decisions live in
 * releaseCheck.logic.ts; this module only talks to the network and the disk
 * (same split as daemonConfig.ts vs daemonConfig.logic.ts). Nothing here
 * imports vscode, so the whole thing is runnable under plain Node in tests.
 */

import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import {
  RELEASE_CHECK_CACHE_VERSION,
  type ReleaseCheckCache,
  type ReleaseBuildSource,
  resolveReleaseCheck,
} from "./releaseCheck.logic.js"

/** `@agentproto/cli` npm package (scoped → `%2F` in the registry URL). */
const CLI_PACKAGE = "@agentproto/cli"
const NPM_LATEST_URL = `https://registry.npmjs.org/${CLI_PACKAGE.replace("/", "%2F")}/latest`

/** `~/.agentproto/release-check.json`. */
export function releaseCheckCachePath(home: string = homedir()): string {
  return join(home, ".agentproto", "release-check.json")
}

export interface FetchLatestCli {
  (opts?: { timeoutMs?: number }): Promise<string | null>
}

/** Fetch the latest published `@agentproto/cli` version from the npm
 *  registry. Returns null on any network error (so the caller can fall back to
 *  the cache / report `unknown`), never throws. */
export async function fetchLatestCliVersion(opts: { timeoutMs?: number } = {}): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 5_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(NPM_LATEST_URL, { signal: controller.signal })
    if (!res.ok) return null
    const body = (await res.json()) as { version?: unknown }
    if (typeof body.version === "string" && body.version.length > 0) return body.version
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Read + parse the cache. Returns null when missing, malformed, or of a
 *  version we don't understand. */
export async function readReleaseCache(
  path: string = releaseCheckCachePath(),
): Promise<ReleaseCheckCache | null> {
  try {
    const raw = await fs.readFile(path, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const c = parsed as Partial<ReleaseCheckCache>
    if (c.version !== RELEASE_CHECK_CACHE_VERSION) return null
    return {
      version: RELEASE_CHECK_CACHE_VERSION,
      latest: typeof c.latest === "string" ? c.latest : null,
      localVersion: typeof c.localVersion === "string" ? c.localVersion : null,
      checkedAtMs: typeof c.checkedAtMs === "number" ? c.checkedAtMs : Number.NaN,
    }
  } catch {
    return null
  }
}

/** Atomically write the cache (tmp + rename), like the other versioned
 *  `~/.agentproto` stores. */
export async function writeReleaseCache(
  next: ReleaseCheckCache,
  path: string = releaseCheckCachePath(),
): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8")
  await fs.rename(tmp, path)
}

export interface ReleaseCheckView {
  /** Decided state. */
  state: "current" | "behind" | "unknown" | "workspace"
  /** Latest `@agentproto/cli` version to trust (fresh npm or fresh cache). */
  latest: string | null
  /** Whether this run used the cache instead of npm. */
  fromCache: boolean
  /** Local CLI version that was compared. */
  localVersion: string | null
}

export interface RunReleaseCheckOptions {
  localVersion: string | null
  buildSource: ReleaseBuildSource
  /** Poll TTL (ms). Pass releaseTtlMs(config) typically. */
  ttlMs: number
  nowMs?: number
  /** Injectable fetcher for tests; defaults to the real npm fetch. */
  fetchLatest?: FetchLatestCli
  cachePath?: string
}

/** Run one release check: consult the cache, fetch npm only when stale, and
 *  persist a successful live result. Offline-safe by construction. */
export async function runReleaseCheck(opts: RunReleaseCheckOptions): Promise<ReleaseCheckView> {
  const nowMs = opts.nowMs ?? Date.now()
  const path = opts.cachePath ?? releaseCheckCachePath()
  const fetchLatest = opts.fetchLatest ?? fetchLatestCliVersion
  const cache = await readReleaseCache(path)

  // Fetch only when the cache can't answer fresh (no cache, wrong version, or
  // TTL expired). A fresh cache is the offline fallback — do not hit npm.
  const cacheFresh = cache && typeof cache.checkedAtMs === "number" && nowMs - cache.checkedAtMs <= opts.ttlMs
  const latestFromNpm = cacheFresh ? null : await fetchLatest()

  const res = resolveReleaseCheck({
    localVersion: opts.localVersion,
    buildSource: opts.buildSource,
    latestFromNpm,
    cache,
    nowMs,
    ttlMs: opts.ttlMs,
  })

  // Persist a live successful result for the next offline window.
  if (latestFromNpm) {
    await writeReleaseCache(
      {
        version: RELEASE_CHECK_CACHE_VERSION,
        latest: latestFromNpm,
        localVersion: opts.localVersion,
        checkedAtMs: nowMs,
      },
      path,
    )
  }

  return {
    state: res.state,
    latest: res.latest,
    fromCache: res.fromCache,
    localVersion: opts.localVersion,
  }
}