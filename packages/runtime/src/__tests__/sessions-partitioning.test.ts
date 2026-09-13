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
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionsRegistry } from "../sessions.js"
import { bucketSessionsFile, listBuckets } from "../workspace-buckets.js"

/** HISTORY_CAP in sessions.ts. Duplicated deliberately: the constant is
 *  module-private, and the point of the assertion is the BOUND's
 *  behaviour, which a test importing the number couldn't distinguish
 *  from the number changing. */
const HISTORY_CAP = 200

/** PERSIST_DEBOUNCE_MS in sessions.ts. Duplicated for the same reason as
 *  HISTORY_CAP above — used to force the debounced async persist to fire
 *  via fake timers rather than waiting on it in real time. */
const PERSIST_DEBOUNCE_MS = 1_500

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

  /** Poll a real-time condition until it's true, or fail after a bound.
   *  Used only by the debounced-persist ("forget") test below, which
   *  exercises the REAL `fs.promises` write behind `schedulePersist` —
   *  fake timers don't reliably pump a pending real I/O promise through
   *  when virtual time is advanced, so this waits on the wall clock
   *  instead. `check` may throw (e.g. the bucket file doesn't exist
   *  yet); that's treated as "not yet". */
  const waitFor = async (check: () => boolean, timeoutMs = PERSIST_DEBOUNCE_MS * 3): Promise<void> => {
    const start = Date.now()
    for (;;) {
      let ok = false
      try {
        ok = check()
      } catch {
        ok = false
      }
      if (ok) return
      if (Date.now() - start > timeoutMs) {
        throw new Error("waitFor: condition never became true in time")
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }

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

  // ── 2026-07-18 bucket-clobber incident ──────────────────────────────
  //
  // A second/skewed daemon shared the same `~/.agentproto/workspaces/`
  // bucket root, and a persist from it emptied `agentik-studio` (61
  // rows → 0) and `choisir-service-public-app` (8 → 0) while the
  // migration marker still recorded the original counts. Three
  // compounding defects, each proven independently below:
  //   1. `readRegisteredSlugs` collapses "read failed" and "genuinely
  //      empty" into the same `Set()`.
  //   2. `groupRowsByBucket` recomputed EVERY row's bucket from
  //      `workspaceSlug` + that (possibly wrong) registry on every
  //      persist, instead of trusting where a row was actually loaded
  //      from.
  //   3. Persist rewrote a bucket wholesale from whatever this daemon
  //      instance happened to have in memory, with no merge against
  //      what was already on disk.

  it("a registry-read failure during persist does NOT empty a populated named bucket", async () => {
    registerWorkspaces("alpha")
    writeBucket("alpha", [
      row("a1", "alpha", "2026-07-01T00:00:00.000Z"),
      row("a2", "alpha", "2026-07-01T00:01:00.000Z"),
    ])

    const registry = createSessionsRegistry({})
    expect(registry.list().map(s => s.id).sort()).toEqual(["a1", "a2"])

    // Force the exact race from the incident: the registry file is
    // unreadable at the moment a persist runs (a real occurrence is a
    // concurrent `saveWorkspacesConfig` tmp+rename; forced here for a
    // deterministic test).
    writeFileSync(join(agentprotoDir, "workspaces.json"), "{ not json")

    await registry.shutdown()

    // Before the fix: an unreadable registry made `alpha` look
    // unregistered, relocating both rows to `default` and writing
    // `alpha` back with zero rows.
    expect(bucketIds("alpha").sort()).toEqual(["a1", "a2"])
  })

  it("a session LOADED from bucket `foo` persists back to `foo` even when `foo` isn't registered", async () => {
    // `foo`'s bucket file exists (a workspace that was registered once,
    // or a hand-placed file), but the registry no longer — or never did
    // — list it. Only `bar` is registered.
    registerWorkspaces("bar")
    writeBucket("foo", [row("f1", "foo", "2026-07-01T00:00:00.000Z")])

    const registry = createSessionsRegistry({})
    expect(registry.list().map(s => s.id)).toEqual(["f1"])

    await registry.shutdown()

    // Before the fix: `resolveBucketSlug("foo", {bar})` recomputes to
    // `default` on every persist regardless of where the row came from,
    // relocating it away from `foo` and emptying `foo`'s file.
    expect(bucketIds("foo")).toEqual(["f1"])
  })

  it("a bucket this daemon never boot-loaded is merged, not clobbered, when a new row resolves into it", async () => {
    registerWorkspaces("alpha")
    // No bucket file for `alpha` exists yet — this daemon's boot-time
    // `listBuckets` finds nothing there and never reads it.
    const registry = createSessionsRegistry({})
    expect(registry.list()).toEqual([])

    // Another process — a concurrently-running daemon, or a second boot
    // that raced this one — populates `alpha` AFTER this daemon already
    // booted, the same shape as the incident's second daemon sharing one
    // bucket root.
    const priorRows = Array.from({ length: 12 }, (_, i) =>
      row(`prior-${i}`, "alpha", `2026-07-01T00:0${i}:00.000Z`),
    )
    writeBucket("alpha", priorRows)

    // This daemon records a brand-new session that resolves into
    // `alpha` purely via the (now-updated) registry — it was never
    // loaded from disk, so `alpha` is still absent from its
    // boot-authoritative bucket set.
    registry.recordCommand({
      workspaceSlug: "alpha",
      cwd: "/tmp/alpha",
      command: "echo",
      args: ["hi"],
      exitCode: 0,
      signal: null,
      durationMs: 1,
      stdout: "",
      stderr: "",
    })

    await registry.shutdown()

    // The bucket grew by one row — it must not have been shrunk to
    // just that one row, discarding the 12 this daemon never read.
    const ids = bucketIds("alpha")
    expect(ids).toHaveLength(13)
    for (const prior of priorRows) expect(ids).toContain(prior.id)
  })

  it("quarantines a malformed bucket file instead of letting the next persist destroy it", async () => {
    registerWorkspaces("alpha")
    // A truncated snapshot — what a write that died mid-flight leaves
    // behind. Before the quarantine, boot ignored it but still counted
    // the bucket as authoritatively loaded, so the first persist
    // overwrote these bytes with the live-only view: the 2026-08-14
    // registry wipe.
    const corrupt = '{"savedAt":"2026-08-14T00:00:00.000Z","sessions":[{"id":"a1"'
    mkdirSync(join(bucketsRoot, "alpha"), { recursive: true })
    writeFileSync(bucketSessionsFile(bucketsRoot, "alpha"), corrupt)

    const registry = createSessionsRegistry({})
    // Nothing loadable — but nothing silently destroyed either.
    expect(registry.list()).toEqual([])
    const quarantined = readdirSync(join(bucketsRoot, "alpha")).filter(f =>
      f.startsWith("sessions.json.corrupt-"),
    )
    expect(quarantined).toHaveLength(1)
    expect(
      readFileSync(join(bucketsRoot, "alpha", quarantined[0]!), "utf8"),
    ).toBe(corrupt)

    // The persist that used to clobber now writes a fresh, valid file —
    // and the quarantined bytes survive it.
    await registry.shutdown()
    const written = JSON.parse(
      readFileSync(bucketSessionsFile(bucketsRoot, "alpha"), "utf8"),
    ) as { sessions: unknown[] }
    expect(written.sessions).toEqual([])
    expect(
      readFileSync(join(bucketsRoot, "alpha", quarantined[0]!), "utf8"),
    ).toBe(corrupt)
  })

  it("forgetting a session in a never-boot-loaded bucket does NOT resurrect it on the next persist", async () => {
    // The merge backstop above (previous test) exists to RESTORE rows a
    // daemon never read. It must not also UNDO a deliberate forget of a
    // row this same daemon created and later removed — that would look
    // identical to a foreign row unless the merge tracks which ids this
    // process has itself ever held.
    //
    // Real timers deliberately, not `vi.useFakeTimers()`: the debounced
    // persist this exercises awaits REAL `fs.promises` writes, and
    // advancing virtual time doesn't reliably pump those through — this
    // waits on the actual PERSIST_DEBOUNCE_MS + write latency instead.
    registerWorkspaces("alpha")
    // `alpha`'s bucket doesn't exist at boot — same not-boot-loaded
    // shape as the merge test above, where the bug lives.
    const registry = createSessionsRegistry({})
    expect(registry.list()).toEqual([])

    const desc = registry.recordCommand({
      workspaceSlug: "alpha",
      cwd: "/tmp/alpha",
      command: "echo",
      args: ["hi"],
      exitCode: 0,
      signal: null,
      durationMs: 1,
      stdout: "",
      stderr: "",
    })

    // First debounced persist actually lands the row on disk.
    await waitFor(() => existsSync(bucketSessionsFile(bucketsRoot, "alpha")) && bucketIds("alpha").includes(desc.id))
    expect(bucketIds("alpha")).toEqual([desc.id])

    // The user forgets it, then a SECOND persist runs from the SAME
    // live daemon — `alpha` is still not in `bootLoadedBuckets`, so
    // this persist still goes through the merge backstop.
    registry.forget(desc.id)
    await waitFor(() => !bucketIds("alpha").includes(desc.id))

    expect(bucketIds("alpha")).toEqual([])

    // And a final shutdown flush agrees — the forget stuck.
    await registry.shutdown()
    expect(bucketIds("alpha")).toEqual([])
  }, 10_000)

  it("a child killed at shutdown cannot re-arm persistence and wipe the buckets", async () => {
    // The 2026-08-14 evening wipe: `shutdownImpl` sync-flushes and then
    // clears the sessions Map, but the children it SIGTERMs emit their
    // "exit" events on later ticks — and that handler calls
    // `schedulePersist()`, arming a fresh debounce timer that nothing
    // cancels. A daemon that stays alive past the debounce (graceful
    // `gateway.stop()`, a slow OS shutdown) then runs a full persist
    // round over the CLEARED registry and writes `sessions: []` into
    // every boot-loaded bucket, on top of the correct final flush.
    //
    // Real timers for the same reason as the forget test above.
    registerWorkspaces("alpha")
    writeBucket("alpha", [row("a1", "alpha", "2026-07-01T00:00:00.000Z")])

    const registry = createSessionsRegistry({})
    expect(registry.list().map(s => s.id)).toEqual(["a1"])

    // A long-lived real child for the shutdown kill-loop to SIGTERM.
    registry.spawn({
      kind: "command",
      workspaceSlug: "alpha",
      cwd: home,
      argv: [process.execPath, "-e", "setTimeout(() => {}, 30000)"],
    })

    await registry.shutdown()
    // The final flush is intact: ghost row still home.
    expect(bucketIds("alpha")).toContain("a1")

    // Now outlive the debounce the child-exit handler may have armed.
    // Pre-fix this is exactly when the wipe lands.
    await new Promise(resolve => setTimeout(resolve, PERSIST_DEBOUNCE_MS + 800))
    expect(bucketIds("alpha")).toContain("a1")
  }, 10_000)

  it("shutting down over a FAILED spawn must not signal the daemon's own process group", async () => {
    // A ChildProcess whose spawn failed (bad cwd here) has `pid`
    // undefined but still holds a live libuv handle with internal pid
    // 0 until its async "error" event lands. `.kill()` on it in that
    // window becomes `kill(0, SIGTERM)` — a signal to the CALLER'S own
    // process group. In the daemon that means shutdown kills every
    // session it owns; in this suite it SIGTERM'd the whole vitest
    // worker tree (how the bug was found). The registry must skip the
    // kill for a child that never spawned.
    registerWorkspaces("alpha")
    writeBucket("alpha", [row("a1", "alpha", "2026-07-01T00:00:00.000Z")])
    const registry = createSessionsRegistry({})

    registry.spawn({
      kind: "command",
      workspaceSlug: "alpha",
      cwd: join(home, "does-not-exist"),
      argv: [process.execPath, "-e", "setTimeout(() => {}, 30000)"],
    })
    // Same tick — the spawn-error event has NOT fired yet, so the row
    // still reads "starting" and the shutdown kill-loop targets it.
    await registry.shutdown()

    // Surviving to this line IS the assertion (pre-fix, SIGTERM tears
    // the test process down before it gets here). The flush also still
    // has the ghost row.
    expect(bucketIds("alpha")).toContain("a1")
  }, 10_000)
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
