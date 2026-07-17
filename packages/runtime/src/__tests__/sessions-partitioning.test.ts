/**
 * AIP-46 §State partitioning, at the registry level: does a session's
 * state actually land in its own workspace's bucket, and is HISTORY_CAP
 * now a per-bucket bound rather than a contested global budget?
 *
 * HOME-isolated (`os.homedir()` reads `$HOME` on POSIX). A developer's
 * real `~/.agentproto/sessions.json` is off-limits: it is their genuine
 * history, and a live daemon rewrites it continuously, so it is neither
 * safe to touch nor byte-stable enough to assert against. Isolation is
 * proven by an A/B here rather than by byte-comparing that file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionsRegistry } from "../sessions.js"
import { bucketSessionsFile, listBuckets } from "../workspace-buckets.js"

/** HISTORY_CAP in sessions.ts. Duplicated deliberately: the constant is
 *  module-private, and the point of the assertion is the BOUND's
 *  behaviour, which a test importing the number couldn't distinguish
 *  from the number changing. */
const HISTORY_CAP = 200

interface Row {
  id: string
  workspaceSlug: string
  startedAt: string
  status: string
  kind: string
  cwd: string
}

const row = (id: string, slug: string, startedAt: string): Row => ({
  id,
  workspaceSlug: slug,
  startedAt,
  status: "exited",
  kind: "agent-cli",
  cwd: `/tmp/${slug}`,
})

describe("sessions registry — per-workspace partitioning", () => {
  let home: string
  let agentprotoDir: string
  let bucketsRoot: string
  let legacy: string
  const realHome = process.env.HOME

  const registerWorkspaces = (...slugs: string[]) => {
    writeFileSync(
      join(agentprotoDir, "workspaces.json"),
      JSON.stringify({
        version: 1,
        active: slugs[0],
        workspaces: slugs.map(slug => ({
          slug,
          path: `/tmp/${slug}`,
          addedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })),
      }),
    )
  }

  const writeBucket = (slug: string, rows: Row[]) => {
    mkdirSync(join(bucketsRoot, slug), { recursive: true })
    writeFileSync(
      bucketSessionsFile(bucketsRoot, slug),
      JSON.stringify({ savedAt: "2026-07-01T00:00:00.000Z", sessions: rows }),
    )
  }

  const bucketIds = (slug: string): string[] =>
    (
      JSON.parse(readFileSync(bucketSessionsFile(bucketsRoot, slug), "utf8")) as {
        sessions: { id: string }[]
      }
    ).sessions.map(s => s.id)

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agentproto-partition-"))
    process.env.HOME = home
    agentprotoDir = join(home, ".agentproto")
    mkdirSync(agentprotoDir, { recursive: true })
    bucketsRoot = join(agentprotoDir, "workspaces")
    legacy = join(agentprotoDir, "sessions.json")
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    rmSync(home, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it("loads each bucket's history and keeps the buckets separate on write", async () => {
    registerWorkspaces("alpha", "beta")
    writeBucket("alpha", [row("a1", "alpha", "2026-07-01T00:00:00.000Z")])
    writeBucket("beta", [row("b1", "beta", "2026-07-01T00:00:00.000Z")])

    const registry = createSessionsRegistry({})
    expect(registry.list().map(s => s.id).sort()).toEqual(["a1", "b1"])

    await registry.shutdown()

    // Each row went home, and neither bucket learned about the other.
    expect(bucketIds("alpha")).toEqual(["a1"])
    expect(bucketIds("beta")).toEqual(["b1"])
  })

  it("HISTORY_CAP is PER BUCKET — a busy workspace cannot evict a quiet one", async () => {
    // The measured harm, inverted into a test. Before partitioning this
    // is the exact shape that loses data: `busy` alone exceeds the cap,
    // and a global sort-by-recency then drops every one of `quiet`'s
    // older rows despite `quiet` having done nothing wrong.
    registerWorkspaces("busy", "quiet")

    const busy = Array.from({ length: HISTORY_CAP + 50 }, (_, i) =>
      // Newest — these would win a global recency race outright.
      row(`busy-${i}`, "busy", `2026-07-02T${String(i % 24).padStart(2, "0")}:00:00.000Z`),
    )
    const quiet = Array.from({ length: 8 }, (_, i) =>
      // Oldest — the first thing a global cap discards. A single-digit
      // row count is a realistic size for a workspace someone touches
      // occasionally, which is exactly the case a global cap punishes.
      row(`quiet-${i}`, "quiet", `2026-01-0${i + 1}T00:00:00.000Z`),
    )
    writeBucket("busy", busy)
    writeBucket("quiet", quiet)

    const registry = createSessionsRegistry({})
    const loaded = registry.list()

    // Quiet's history survives IN FULL despite being both older and
    // vastly outnumbered — this is the fairness property.
    const survivingQuiet = loaded.filter(s => s.id.startsWith("quiet-"))
    expect(survivingQuiet).toHaveLength(8)

    // Busy is capped by its OWN volume, not by a shared budget.
    const survivingBusy = loaded.filter(s => s.id.startsWith("busy-"))
    expect(survivingBusy).toHaveLength(HISTORY_CAP)

    // And the total exceeds the old global bound, which is precisely
    // what a global cap made impossible.
    expect(loaded.length).toBe(HISTORY_CAP + 8)
    expect(loaded.length).toBeGreaterThan(HISTORY_CAP)

    await registry.shutdown()
  })

  it("COUNTERFACTUAL: the same rows pooled in one file DO evict the quiet workspace", async () => {
    // The other half of the test above, and the reason it means
    // anything. Identical fixture, single-file (unpartitioned) mode —
    // the shape the daemon shipped until now. `quiet` is wiped out.
    // If this ever starts passing with quiet's rows intact, the test
    // above has stopped proving anything.
    const pooled = join(home, "pooled-sessions.json")
    const busy = Array.from({ length: HISTORY_CAP + 50 }, (_, i) =>
      row(`busy-${i}`, "busy", `2026-07-02T${String(i % 24).padStart(2, "0")}:00:00.000Z`),
    )
    const quiet = Array.from({ length: 8 }, (_, i) =>
      row(`quiet-${i}`, "quiet", `2026-01-0${i + 1}T00:00:00.000Z`),
    )
    writeFileSync(
      pooled,
      JSON.stringify({ savedAt: "2026-07-01T00:00:00.000Z", sessions: [...busy, ...quiet] }),
    )

    const registry = createSessionsRegistry({ persistPath: pooled })
    const loaded = registry.list()

    // Every one of quiet's 8 rows is gone — evicted by a neighbour's
    // busy afternoon.
    expect(loaded.filter(s => s.id.startsWith("quiet-"))).toHaveLength(0)
    // The global bound is spent entirely on the busiest workspace.
    expect(loaded).toHaveLength(HISTORY_CAP)
    expect(loaded.every(s => s.id.startsWith("busy-"))).toBe(true)

    await registry.shutdown()
  })

  it("migrates the legacy global file into buckets on first boot, non-destructively", async () => {
    registerWorkspaces("alpha", "beta")
    writeFileSync(
      legacy,
      JSON.stringify({
        savedAt: "2026-07-01T00:00:00.000Z",
        sessions: [
          row("a1", "alpha", "2026-07-01T00:00:00.000Z"),
          row("b1", "beta", "2026-07-01T00:01:00.000Z"),
          row("u1", "unregistered-thing", "2026-07-01T00:02:00.000Z"),
        ],
      }),
    )
    const before = readFileSync(legacy)

    const registry = createSessionsRegistry({})

    // Every row is back in memory — nothing orphaned by the split.
    expect(registry.list().map(s => s.id).sort()).toEqual(["a1", "b1", "u1"])
    // And partitioned the way the rule says.
    expect(listBuckets(bucketsRoot).sort()).toEqual(["alpha", "beta", "default"])
    expect(bucketIds("alpha")).toEqual(["a1"])
    expect(bucketIds("beta")).toEqual(["b1"])
    expect(bucketIds("default")).toEqual(["u1"])

    // The hard constraint: the user's file is untouched.
    expect(readFileSync(legacy).equals(before)).toBe(true)

    await registry.shutdown()
    expect(readFileSync(legacy).equals(before)).toBe(true)
  })

  it("a workspace registered while the daemon is up buckets without a restart", async () => {
    // The registry is re-read per persist rather than cached at boot, so
    // `workspace add` takes effect immediately instead of silently
    // pooling into `default` until the next restart.
    registerWorkspaces("alpha")
    const registry = createSessionsRegistry({})

    registerWorkspaces("alpha", "gamma")
    writeBucket("gamma", []) // nothing yet
    const fresh = createSessionsRegistry({})
    await fresh.shutdown()
    await registry.shutdown()

    expect(listBuckets(bucketsRoot)).toContain("gamma")
  })

  it("persistPath still means one exact file (the #411 knob keeps working)", async () => {
    // Partitioning must not quietly change what `persistPath` means —
    // it names a file, and #411's tests assert on that file.
    const pinned = join(home, "pinned-sessions.json")
    const registry = createSessionsRegistry({ persistPath: pinned })
    await registry.shutdown()

    expect(existsSync(pinned)).toBe(true)
    // ...and nothing was partitioned alongside it.
    expect(listBuckets(bucketsRoot)).toEqual([])
  })

  it("persist:false writes nothing at all, partitioned or not", async () => {
    registerWorkspaces("alpha")
    const registry = createSessionsRegistry({ persist: false })
    await registry.shutdown()

    expect(listBuckets(bucketsRoot)).toEqual([])
    expect(existsSync(legacy)).toBe(false)
  })
})

describe("isolated-HOME A/B — a workspace's state lands in its own bucket", () => {
  const realHome = process.env.HOME
  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    vi.restoreAllMocks()
  })

  it("two HOMEs, same slug, zero cross-talk", async () => {
    // The A/B the byte-identity oracle can't give us: a real
    // sessions.json changes constantly (a live daemon owns it), so
    // "didn't change" is unassertable. Instead run the same workspace
    // slug under two independent HOMEs and prove neither sees the other.
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const homes = [
      mkdtempSync(join(tmpdir(), "agentproto-ab-a-")),
      mkdtempSync(join(tmpdir(), "agentproto-ab-b-")),
    ]
    try {
      for (const [i, home] of homes.entries()) {
        process.env.HOME = home
        const dir = join(home, ".agentproto")
        mkdirSync(join(dir, "workspaces", "shared-slug"), { recursive: true })
        writeFileSync(
          join(dir, "workspaces.json"),
          JSON.stringify({
            version: 1,
            active: "shared-slug",
            workspaces: [
              {
                slug: "shared-slug",
                path: "/tmp/shared-slug",
                addedAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          }),
        )
        writeFileSync(
          join(dir, "workspaces", "shared-slug", "sessions.json"),
          JSON.stringify({
            savedAt: "2026-07-01T00:00:00.000Z",
            sessions: [row(`home-${i}-session`, "shared-slug", "2026-07-01T00:00:00.000Z")],
          }),
        )
      }

      for (const [i, home] of homes.entries()) {
        process.env.HOME = home
        const registry = createSessionsRegistry({})
        // Sees ONLY its own HOME's row for the identically-named slug.
        expect(registry.list().map(s => s.id)).toEqual([`home-${i}-session`])
        await registry.shutdown()
      }

      // And after both ran, each HOME still holds exactly its own.
      for (const [i, home] of homes.entries()) {
        const written = JSON.parse(
          readFileSync(join(home, ".agentproto", "workspaces", "shared-slug", "sessions.json"), "utf8"),
        ) as { sessions: { id: string }[] }
        expect(written.sessions.map(s => s.id)).toEqual([`home-${i}-session`])
      }
    } finally {
      for (const home of homes) rmSync(home, { recursive: true, force: true })
    }
  })
})
