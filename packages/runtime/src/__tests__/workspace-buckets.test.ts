/**
 * AIP-46 §State partitioning — the slug→bucket rule and the additive
 * split of the legacy global snapshot.
 *
 * Fixture-driven and HOME-isolated throughout. A developer's real
 * `~/.agentproto/sessions.json` is their genuine history, backed by a
 * transcript store that can reach hundreds of megabytes, and a live
 * daemon rewrites it continuously — so it is neither safe to touch nor
 * byte-stable enough to assert against. `os.homedir()` reads `$HOME` on
 * POSIX, which is the lever — same trick as
 * `packages/cli/src/__tests__/install-skill.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_BUCKET,
  BUCKETS_ROOT,
  LEGACY_SESSIONS_FILE,
  bucketSessionsFile,
  isSafeBucketSlug,
  listBuckets,
  mergeBucketRows,
  migrateLegacySessionsFile,
  migrationMarkerPath,
  readRegisteredSlugs,
  resolveBucketSlug,
} from "../workspace-buckets.js"

const REGISTERED = new Set(["agentik-studio", "client-app"])

describe("resolveBucketSlug", () => {
  it("sends a registered slug to its own bucket", () => {
    expect(resolveBucketSlug("agentik-studio", REGISTERED)).toBe("agentik-studio")
    expect(resolveBucketSlug("client-app", REGISTERED)).toBe(
      "client-app",
    )
  })

  it("falls back to `default` for an unregistered slug", () => {
    // `vitest-e2e` is the shape test gateways left behind before #411
    // closed that leak. Nothing registers it, so it pools rather than
    // getting a bucket of its own.
    expect(resolveBucketSlug("vitest-e2e", REGISTERED)).toBe(DEFAULT_BUCKET)
  })

  it("falls back to `default` for absent / empty slugs", () => {
    expect(resolveBucketSlug(undefined, REGISTERED)).toBe(DEFAULT_BUCKET)
    expect(resolveBucketSlug(null, REGISTERED)).toBe(DEFAULT_BUCKET)
    // An empty slug is a shape that occurs in practice, not a
    // hypothetical — it must pool rather than become a bucket named "".
    expect(resolveBucketSlug("", REGISTERED)).toBe(DEFAULT_BUCKET)
  })

  it("routes `default` itself to the default bucket even unregistered", () => {
    expect(resolveBucketSlug("default", REGISTERED)).toBe(DEFAULT_BUCKET)
  })

  it("cannot be talked into path traversal", () => {
    // `session-spawn.ts` passes `input.workspaceSlug` straight onto the
    // descriptor when an explicit `cwd` accompanies it — nothing
    // sanitises it — so a descriptor CAN carry these. Membership is what
    // stops them: none is registered, so each lands in `default` rather
    // than escaping the state root.
    for (const evil of [
      "../../etc",
      "../../../../../../tmp/pwned",
      "/etc/passwd",
      "..",
      ".",
      "a/b",
      "foo bar",
      // Written as an ESCAPE, never a literal 0x00: one raw NUL in the
      // source makes git classify this whole file as binary ("Bin 0 ->
      // 14319 bytes", rendered as "Binary file not shown"), which would
      // hide the very test that proves the membership rule closes the
      // traversal primitive. NUL-injection earns its place as a vector
      // anyway: it is the classic path-truncation trick, and it must die
      // on membership like every other unregistered slug.
      "foo\0bar",
    ]) {
      expect(resolveBucketSlug(evil, REGISTERED)).toBe(DEFAULT_BUCKET)
    }
  })

  it("refuses an unsafe slug even if the registry somehow contains it", () => {
    // Defence in depth: `sanitizeSlug` makes this unreachable through
    // `addWorkspace`, so this asserts the belt behind the braces — a
    // hand-mangled registry still cannot produce a traversing path.
    const poisoned = new Set(["../../etc"])
    expect(resolveBucketSlug("../../etc", poisoned)).toBe(DEFAULT_BUCKET)
  })

  it("treats slugs as exact, not fuzzy", () => {
    expect(resolveBucketSlug("AGENTIK-STUDIO", REGISTERED)).toBe(DEFAULT_BUCKET)
    expect(resolveBucketSlug("agentik-studio ", REGISTERED)).toBe(DEFAULT_BUCKET)
    expect(resolveBucketSlug("agentik", REGISTERED)).toBe(DEFAULT_BUCKET)
  })
})

describe("isSafeBucketSlug", () => {
  it("accepts what sanitizeSlug produces", () => {
    for (const ok of ["a", "agentik-studio", "with_underscore", "0-leading-digit"]) {
      expect(isSafeBucketSlug(ok)).toBe(true)
    }
  })
  it("rejects separators, dots, and the empty string", () => {
    for (const bad of ["", ".", "..", "a/b", "a\\b", "a.b", "-leading-hyphen", "A"]) {
      expect(isSafeBucketSlug(bad)).toBe(false)
    }
  })
  it("rejects an over-long slug", () => {
    expect(isSafeBucketSlug("a".repeat(64))).toBe(true)
    expect(isSafeBucketSlug("a".repeat(65))).toBe(false)
  })
})

describe("mergeBucketRows", () => {
  const r = (id: string) => ({ id, status: "exited" })

  it("preserves a foreign on-disk row — never held by this process", () => {
    // The clobber-prevention case: a row this daemon never loaded and
    // never created must survive a merge untouched.
    const onDisk = [r("foreign-1"), r("foreign-2")]
    const merged = mergeBucketRows(onDisk, [], new Set())
    expect(merged).toEqual([r("foreign-1"), r("foreign-2")])
  })

  it("does NOT resurrect an ever-held id that's absent from `rows`", () => {
    // The forget-regression case: `mine-1` is on disk from an earlier
    // persist by THIS process, but the caller no longer carries it in
    // `rows` (it was deliberately forgotten) — `everHeldIds` says so,
    // and the merge must respect that instead of treating it as foreign.
    const onDisk = [r("mine-1"), r("foreign-1")]
    const merged = mergeBucketRows(onDisk, [], new Set(["mine-1"]))
    expect(merged).toEqual([r("foreign-1")])
  })

  it("incoming rows win by id over their on-disk counterpart", () => {
    const onDisk = [{ id: "a1", status: "running" }]
    const rows = [{ id: "a1", status: "exited" }]
    const merged = mergeBucketRows(onDisk, rows, new Set(["a1"]))
    expect(merged).toEqual([{ id: "a1", status: "exited" }])
  })

  it("combines: incoming rows plus genuinely foreign on-disk rows, minus forgotten ever-held ones", () => {
    const onDisk = [r("foreign-1"), r("forgotten-1"), r("live-1")]
    const rows = [{ id: "live-1", status: "exited" }, r("new-1")]
    const merged = mergeBucketRows(onDisk, rows, new Set(["forgotten-1", "live-1", "new-1"]))
    expect(merged).toEqual([
      { id: "live-1", status: "exited" },
      r("new-1"),
      r("foreign-1"),
    ])
  })
})

describe("HOME-isolated bucket paths", () => {
  let home: string
  const realHome = process.env.HOME

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agentproto-buckets-"))
    process.env.HOME = home
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    rmSync(home, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it("resolves the bucket root and legacy file under $HOME", () => {
    // Proves the isolation lever itself works before anything relies on
    // it — if this fails, every migration test below is silently
    // pointing at the developer's real home.
    expect(BUCKETS_ROOT()).toBe(join(home, ".agentproto", "workspaces"))
    expect(LEGACY_SESSIONS_FILE()).toBe(join(home, ".agentproto", "sessions.json"))
  })

  it("reads registered slugs from the isolated registry", () => {
    mkdirSync(join(home, ".agentproto"), { recursive: true })
    writeFileSync(
      join(home, ".agentproto", "workspaces.json"),
      JSON.stringify({
        version: 1,
        active: "alpha",
        workspaces: [
          { slug: "alpha", path: "/tmp/alpha", addedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
          { slug: "beta", path: "/tmp/beta", addedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
        ],
      }),
    )
    expect([...readRegisteredSlugs()].sort()).toEqual(["alpha", "beta"])
  })

  it("degrades to `nothing registered` when the registry is missing", () => {
    // The safe failure direction: everything pools into `default`, i.e.
    // today's behaviour, rather than the daemon refusing to persist.
    expect(readRegisteredSlugs().size).toBe(0)
  })

  it("degrades to `nothing registered` when the registry is corrupt", () => {
    mkdirSync(join(home, ".agentproto"), { recursive: true })
    writeFileSync(join(home, ".agentproto", "workspaces.json"), "{ not json")
    expect(readRegisteredSlugs().size).toBe(0)
  })
})

describe("migrateLegacySessionsFile", () => {
  let home: string
  let root: string
  let legacy: string
  const realHome = process.env.HOME

  const row = (id: string, slug?: string, startedAt = "2026-07-01T00:00:00.000Z") => ({
    id,
    ...(slug !== undefined ? { workspaceSlug: slug } : {}),
    startedAt,
    status: "exited",
    kind: "agent-cli",
  })

  const writeLegacy = (sessions: unknown[]) => {
    mkdirSync(join(home, ".agentproto"), { recursive: true })
    writeFileSync(legacy, JSON.stringify({ savedAt: "2026-07-01T00:00:00.000Z", sessions }, null, 2))
  }

  const readBucket = (slug: string): { sessions: { id: string }[] } =>
    JSON.parse(readFileSync(bucketSessionsFile(root, slug), "utf8")) as {
      sessions: { id: string }[]
    }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agentproto-migrate-"))
    process.env.HOME = home
    root = join(home, ".agentproto", "workspaces")
    legacy = join(home, ".agentproto", "sessions.json")
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    rmSync(home, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it("splits rows into buckets by slug, unregistered into `default`", () => {
    // A representative multi-workspace distribution: a large pooled
    // `default`, one busy registered workspace, one quiet registered
    // workspace, and a tail of rows whose slug nobody registered
    // (a test-harness slug, an empty string, an absent field).
    writeLegacy([
      row("a1", "agentik-studio"),
      row("a2", "agentik-studio"),
      row("c1", "client-app"),
      row("v1", "vitest-e2e"), // registered by nobody
      row("e1", ""), // empty slug — occurs in practice
      row("u1"), // no slug at all
      row("d1", "default"),
    ])

    const marker = migrateLegacySessionsFile({
      root,
      legacyFile: legacy,
      registered: REGISTERED,
    })

    expect(marker).not.toBeNull()
    expect(marker?.rows).toBe(7)
    expect(marker?.byBucket).toEqual({
      "agentik-studio": 2,
      "client-app": 1,
      default: 4,
    })

    expect(readBucket("agentik-studio").sessions.map(s => s.id).sort()).toEqual(["a1", "a2"])
    expect(readBucket("client-app").sessions.map(s => s.id)).toEqual(["c1"])
    expect(readBucket("default").sessions.map(s => s.id).sort()).toEqual(["d1", "e1", "u1", "v1"])
  })

  it("never drops a row it cannot place", () => {
    writeLegacy([row("x1", "nope-1"), row("x2", "nope-2"), row("x3", "../../etc")])
    const marker = migrateLegacySessionsFile({ root, legacyFile: legacy, registered: REGISTERED })
    // Every row accounted for, and the sum of the buckets equals the input.
    const placed = Object.values(marker?.byBucket ?? {}).reduce((a, b) => a + b, 0)
    expect(placed).toBe(3)
    expect(readBucket("default").sessions.map(s => s.id).sort()).toEqual(["x1", "x2", "x3"])
  })

  it("is NON-DESTRUCTIVE — the legacy file is byte-identical afterwards", () => {
    // The hard constraint. A developer's real file is their genuine
    // history and their only rollback; a migration that mutates it is
    // unacceptable regardless of how correct the split is.
    writeLegacy([row("a1", "agentik-studio"), row("u1")])
    const before = readFileSync(legacy)

    migrateLegacySessionsFile({ root, legacyFile: legacy, registered: REGISTERED })

    const after = readFileSync(legacy)
    expect(after.equals(before)).toBe(true)
  })

  it("completes with the legacy file mode 0444 (read-only)", () => {
    // Stronger than "didn't happen to write": proves it CANNOT write,
    // i.e. the migration would fail loudly rather than silently mutating
    // a file it was only supposed to read.
    writeLegacy([row("a1", "agentik-studio"), row("c1", "client-app")])
    chmodSync(legacy, 0o444)
    try {
      const marker = migrateLegacySessionsFile({ root, legacyFile: legacy, registered: REGISTERED })
      expect(marker?.rows).toBe(2)
      expect(readBucket("agentik-studio").sessions.map(s => s.id)).toEqual(["a1"])
    } finally {
      chmodSync(legacy, 0o644)
    }
  })

  it("writes an auditable marker", () => {
    writeLegacy([row("a1", "agentik-studio"), row("u1")])
    migrateLegacySessionsFile({ root, legacyFile: legacy, registered: REGISTERED })

    const marker = JSON.parse(readFileSync(migrationMarkerPath(root), "utf8")) as {
      version: number
      from: string
      rows: number
      byBucket: Record<string, number>
      migratedAt: string
    }
    expect(marker.version).toBe(1)
    expect(marker.from).toBe(legacy)
    expect(marker.rows).toBe(2)
    expect(marker.byBucket).toEqual({ "agentik-studio": 1, default: 1 })
    expect(() => new Date(marker.migratedAt).toISOString()).not.toThrow()
  })

  it("is idempotent — a second boot re-imports nothing", () => {
    writeLegacy([row("a1", "agentik-studio")])
    expect(migrateLegacySessionsFile({ root, legacyFile: legacy, registered: REGISTERED })).not.toBeNull()

    // The user deletes a row from their bucket. The legacy file still
    // has it — absence of the legacy file can't be the idempotency
    // signal, or this row comes back from the dead every boot.
    writeFileSync(
      bucketSessionsFile(root, "agentik-studio"),
      JSON.stringify({ savedAt: "2026-07-02T00:00:00.000Z", sessions: [] }),
    )

    expect(migrateLegacySessionsFile({ root, legacyFile: legacy, registered: REGISTERED })).toBeNull()
    expect(readBucket("agentik-studio").sessions).toEqual([])
  })

  it("does not clobber rows already in a bucket", () => {
    mkdirSync(join(root, "agentik-studio"), { recursive: true })
    writeFileSync(
      bucketSessionsFile(root, "agentik-studio"),
      JSON.stringify({ savedAt: "2026-07-02T00:00:00.000Z", sessions: [row("live-1", "agentik-studio")] }),
    )
    writeLegacy([row("a1", "agentik-studio"), row("live-1", "agentik-studio")])

    migrateLegacySessionsFile({ root, legacyFile: legacy, registered: REGISTERED })

    // `live-1` present once (bucket copy wins), `a1` merged in.
    expect(readBucket("agentik-studio").sessions.map(s => s.id).sort()).toEqual(["a1", "live-1"])
  })

  it("no legacy file is a no-op, not an error", () => {
    expect(migrateLegacySessionsFile({ root, legacyFile: legacy, registered: REGISTERED })).toBeNull()
    expect(listBuckets(root)).toEqual([])
  })

  it("leaves a malformed legacy file in place and starts empty", () => {
    mkdirSync(join(home, ".agentproto"), { recursive: true })
    writeFileSync(legacy, "{ this is not json")
    const before = readFileSync(legacy)

    expect(migrateLegacySessionsFile({ root, legacyFile: legacy, registered: REGISTERED })).toBeNull()

    expect(readFileSync(legacy).equals(before)).toBe(true)
    expect(listBuckets(root)).toEqual([])
  })

  it("ignores rows without a usable id", () => {
    writeLegacy([row("a1", "agentik-studio"), { workspaceSlug: "agentik-studio" }, null, 42])
    const marker = migrateLegacySessionsFile({ root, legacyFile: legacy, registered: REGISTERED })
    expect(marker?.rows).toBe(1)
  })
})

describe("listBuckets", () => {
  let home: string
  const realHome = process.env.HOME

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agentproto-list-"))
    process.env.HOME = home
  })
  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    rmSync(home, { recursive: true, force: true })
  })

  it("lists only directories with safe names", () => {
    const root = join(home, ".agentproto", "workspaces")
    mkdirSync(join(root, "alpha"), { recursive: true })
    mkdirSync(join(root, "beta"), { recursive: true })
    writeFileSync(join(root, ".migration.json"), "{}") // a file, and unsafe-named
    expect(listBuckets(root).sort()).toEqual(["alpha", "beta"])
  })

  it("is empty (not an error) when nothing is partitioned", () => {
    expect(listBuckets(join(home, ".agentproto", "workspaces"))).toEqual([])
  })
})
