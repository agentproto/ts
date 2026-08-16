import { describe, expect, it } from "vitest"

import {
  RELEASE_CHECK_CACHE_VERSION,
  RELEASE_CHECK_MIN_TTL_MS,
  compareRelease,
  compareVersions,
  isCacheFresh,
  releaseTtlMs,
  resolveReleaseCheck,
  type ReleaseCheckCache,
  type ReleaseBuildSource,
} from "./releaseCheck.logic.js"

const NOW = Date.parse("2026-08-16T12:00:00.000Z")

function cache(over: Partial<ReleaseCheckCache> = {}): ReleaseCheckCache {
  return {
    version: RELEASE_CHECK_CACHE_VERSION,
    latest: "0.14.0",
    localVersion: "0.14.0",
    checkedAtMs: NOW - 60_000,
    ...over,
  }
}

describe("compareVersions", () => {
  it("orders major.minor.patch numerically", () => {
    expect(compareVersions("0.15.0", "0.14.0")).toBeGreaterThan(0)
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0)
    expect(compareVersions("0.2.1", "0.2.0")).toBeGreaterThan(0)
  })

  it("treats equal versions as equal, tolerating a v prefix", () => {
    expect(compareVersions("0.14.0", "0.14.0")).toBe(0)
    expect(compareVersions("v0.14.0", "0.14.0")).toBe(0)
  })

  it("treats unparseable or prerelease-suffixed versions safely", () => {
    expect(compareVersions("abc", "0.14.0")).toBe(0)
    expect(compareVersions("0.15.0-beta.1", "0.14.0")).toBeGreaterThan(0)
  })
})

describe("compareRelease — local == latest", () => {
  it("says current for a published tarball on the same version", () => {
    expect(compareRelease("0.14.0", "0.14.0", "tarball")).toBe("current")
  })
  it("says current when local is AHEAD of npm (local-only work)", () => {
    expect(compareRelease("0.15.0", "0.14.0", "tarball")).toBe("current")
  })
})

describe("compareRelease — local behind latest", () => {
  it("says behind for a published tarball below npm", () => {
    expect(compareRelease("0.14.0", "0.15.0", "tarball")).toBe("behind")
  })
  it("says behind when buildSource is absent (missing field reads as tarball)", () => {
    expect(compareRelease("0.14.0", "0.15.0", null)).toBe("behind")
  })
})

describe("compareRelease — workspace mode", () => {
  it("signals workspace distinctly, not behind", () => {
    expect(compareRelease("0.14.0", "0.15.0", "workspace")).toBe("workspace")
  })
  it("still signals workspace when versions are equal", () => {
    expect(compareRelease("0.14.0", "0.14.0", "workspace")).toBe("workspace")
  })
})

describe("compareRelease — unknown (offline-safe)", () => {
  it("never claims an update when npm latest is unavailable", () => {
    expect(compareRelease("0.14.0", null, "tarball")).toBe("unknown")
    expect(compareRelease("0.14.0", undefined, "tarball")).toBe("unknown")
  })
  it("never claims an update when local version is unavailable", () => {
    expect(compareRelease(null, "0.15.0", "tarball")).toBe("unknown")
  })
})

describe("releaseTtlMs", () => {
  it("defaults to ~1 h", () => {
    expect(releaseTtlMs(undefined)).toBe(60 * 60 * 1000)
    expect(releaseTtlMs(0)).toBe(60 * 60 * 1000)
  })
  it("honours a configured interval", () => {
    expect(releaseTtlMs(30)).toBe(30 * 60 * 1000)
  })
  it("clamps to the 10 min floor", () => {
    expect(releaseTtlMs(2)).toBe(RELEASE_CHECK_MIN_TTL_MS)
    expect(releaseTtlMs(1)).toBe(RELEASE_CHECK_MIN_TTL_MS)
  })
})

describe("isCacheFresh", () => {
  it("treats a recent cache as fresh", () => {
    expect(isCacheFresh(cache(), NOW, 60 * 60 * 1000)).toBe(true)
  })
  it("treats an old or absent cache as stale", () => {
    const old = cache({ checkedAtMs: NOW - 2 * 60 * 60 * 1000 })
    expect(isCacheFresh(old, NOW, 60 * 60 * 1000)).toBe(false)
    expect(isCacheFresh(null, NOW, 60 * 60 * 1000)).toBe(false)
  })
  it("rejects a mismatched version or a broken timestamp", () => {
    expect(isCacheFresh(cache({ version: 99 }), NOW, 60 * 60 * 1000)).toBe(false)
    expect(isCacheFresh(cache({ checkedAtMs: Number.NaN }), NOW, 60 * 60 * 1000)).toBe(false)
  })
})

describe("resolveReleaseCheck — offline-safe end to end", () => {
  const build: ReleaseBuildSource = "tarball"

  it("uses a live npm result when one is present", () => {
    const res = resolveReleaseCheck({
      localVersion: "0.14.0",
      buildSource: build,
      latestFromNpm: "0.15.0",
      cache: cache({ latest: "0.13.0" }),
      nowMs: NOW,
      ttlMs: 60 * 60 * 1000,
    })
    expect(res.state).toBe("behind")
    expect(res.latest).toBe("0.15.0")
    expect(res.fromCache).toBe(false)
  })

  it("falls back to a FRESH cache when the network fetch failed", () => {
    const res = resolveReleaseCheck({
      localVersion: "0.14.0",
      buildSource: build,
      latestFromNpm: null,
      cache: cache({ latest: "0.15.0", checkedAtMs: NOW - 60_000 }),
      nowMs: NOW,
      ttlMs: 60 * 60 * 1000,
    })
    expect(res.state).toBe("behind")
    expect(res.latest).toBe("0.15.0")
    expect(res.fromCache).toBe(true)
  })

  it("returns unknown (never a false behind) when the fetch failed and the cache is STALE", () => {
    const res = resolveReleaseCheck({
      localVersion: "0.14.0",
      buildSource: build,
      latestFromNpm: null,
      cache: cache({ latest: "0.15.0", checkedAtMs: NOW - 2 * 60 * 60 * 1000 }),
      nowMs: NOW,
      ttlMs: 60 * 60 * 1000,
    })
    expect(res.state).toBe("unknown")
    expect(res.latest).toBeNull()
    // The stale cache is still surfaced as informational, not as a verdict.
    expect(res.cachedLatest).toBe("0.15.0")
  })

  it("returns unknown when there is no cache at all and the fetch failed", () => {
    const res = resolveReleaseCheck({
      localVersion: "0.14.0",
      buildSource: build,
      latestFromNpm: null,
      cache: null,
      nowMs: NOW,
      ttlMs: 60 * 60 * 1000,
    })
    expect(res.state).toBe("unknown")
    expect(res.latest).toBeNull()
  })

  it("does not let a fresh-cache fallback invent a workspace verdict", () => {
    const res = resolveReleaseCheck({
      localVersion: "0.14.0",
      buildSource: "workspace",
      latestFromNpm: null,
      cache: cache({ latest: "0.15.0" }),
      nowMs: NOW,
      ttlMs: 60 * 60 * 1000,
    })
    expect(res.state).toBe("workspace")
    expect(res.latest).toBe("0.15.0")
  })
})