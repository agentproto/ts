import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { gunzipSync } from "node:zlib"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { StoreLockedError, StoreVersionError, itemSeenKeys, readAll } from "../index"
import { StoreMigrationError, StoreNotFoundError, initStore, openStore } from "../node"
import { actor, item, observation, recipe, T, testDir } from "./helpers"
import type { Reader } from "../index"
import { storeContract } from "./store-contract"

const dirs: Array<() => Promise<void>> = []
afterEach(async () => {
  while (dirs.length) await dirs.pop()?.()
})
async function dir() {
  const d = await testDir()
  dirs.push(d.cleanup)
  return d.path
}

storeContract("disk store", async () => {
  const d = await testDir()
  const store = await initStore(d.path)
  return { store, reopen: () => openStore(d.path), cleanup: d.cleanup }
})

describe("disk store layout and failures", () => {
  it("writes the documented layout", async () => {
    const path = await dir()
    const s = await initStore(path)
    await s.upsertItem(item(1))
    await s.appendObservation(observation(1, 1))
    await s.appendActor(actor("a"))
    await s.appendPickup({
      itemId: "hn:1", kind: "crosspost", relation: "citation", evidence: { similarity: 0.5 },
      method: "near_text", verified: false, firstSeenAt: T, measuredAt: T,
    })
    const r = await s.putRaw({ connector: "web", ext: "json", bytes: new Uint8Array([1]), url: "u", fetchedAt: T, transport: "http" })
    await s.createRun("r1", recipe)
    await s.seenAdd("id:hn:1")
    expect(JSON.parse(await readFile(join(path, "collect.json"), "utf8"))).toEqual({ schemaVersion: 1 })
    expect((await readdir(path)).sort()).toEqual(
      ["actors", "collect.json", "items", "observations", "pickups.jsonl", "raw", "runs", "seen.idx"].sort(),
    )
    expect(r.ref).toMatch(/^raw\/web\/2026-11\//)
    expect((await readdir(join(path, "raw"))).sort()).toEqual(["index.jsonl", "web"])
    expect(await readdir(join(path, "items"))).toEqual(["hn.jsonl"])
    expect(await readdir(join(path, "runs", "r1"))).toEqual(["recipe.json"])
  })

  it("refuses two concurrent runs on one path, from separate opens", async () => {
    const path = await dir()
    const a = await initStore(path)
    const b = await openStore(path)
    const lock = await a.acquireLock()
    const err = await b.acquireLock().catch((e) => e)
    expect(err).toBeInstanceOf(StoreLockedError)
    expect(err.holder.pid).toBe(process.pid)
    await lock.release()
    await (await b.acquireLock()).release()
  })

  it("breaks a stale lock held by a dead pid, but not a live or foreign one", async () => {
    const path = await dir()
    const s = await initStore(path)
    const os = await import("node:os")
    const stale = { pid: 2 ** 22 + 12345, at: T, host: os.hostname(), token: "x" }
    await writeFile(join(path, "collect.lock"), JSON.stringify(stale))
    await (await s.acquireLock()).release()
    await writeFile(join(path, "collect.lock"), JSON.stringify({ ...stale, host: "another-host" }))
    await expect(s.acquireLock()).rejects.toBeInstanceOf(StoreLockedError)
    await writeFile(join(path, "collect.lock"), "{garbage")
    await expect(s.acquireLock()).rejects.toBeInstanceOf(StoreLockedError)
    expect((await readdir(path)).filter((n) => n.includes(".stale-") || n.endsWith(".tmp"))).toEqual([])
  })

  it("lets exactly one of several contenders break one stale lock", async () => {
    const os = await import("node:os")
    for (let round = 0; round < 25; round++) {
      const path = await dir()
      const deadPid = 4_000_000
      const opts = { pidAlive: (pid: number) => pid !== deadPid }
      await initStore(path)
      await writeFile(join(path, "collect.lock"), JSON.stringify({ pid: deadPid, at: T, host: os.hostname(), token: "dead" }))
      const handles = await Promise.all([openStore(path, opts), openStore(path, opts), openStore(path, opts)])
      const results = await Promise.allSettled(handles.map((h) => h.acquireLock()))
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
      for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(StoreLockedError)
      expect((await readdir(path)).filter((n) => n.includes(".stale-") || n.endsWith(".tmp"))).toEqual([])
    }
  })

  it("never exposes an empty lock file", async () => {
    const path = await dir()
    const a = await initStore(path)
    const b = await openStore(path)
    let sawEmpty = false
    let stop = false
    const watcher = (async () => {
      while (!stop) {
        const st = await stat(join(path, "collect.lock")).catch(() => undefined)
        if (st && st.size === 0) sawEmpty = true
        await new Promise((r) => setImmediate(r))
      }
    })()
    for (let i = 0; i < 40; i++) {
      const [x, y] = await Promise.allSettled([a.acquireLock(), b.acquireLock()])
      for (const r of [x, y]) if (r.status === "fulfilled") await r.value.release()
    }
    stop = true
    await watcher
    expect(sawEmpty).toBe(false)
  })

  it("closes a torn tail before appending, in every kind of log", async () => {
    const path = await dir()
    const s = await initStore(path)
    await s.upsertItem(item(1))
    await s.appendObservation(observation(1, 1))
    await s.appendActor(actor("a"))
    await s.putRaw({ connector: "web", ext: "txt", bytes: new Uint8Array([1]), url: "u1", fetchedAt: T, transport: "http" })
    await s.createRun("r1", recipe)
    await s.appendEvent("r1", { at: T, type: "one" })
    await s.seenAdd("id:hn:1")
    const files = ["items/hn.jsonl", "observations/hn.jsonl", "actors/hn.jsonl", "raw/index.jsonl", "runs/r1/events.jsonl"]
    for (const f of files) await appendFile(join(path, f), '{"torn":')
    const fresh = await openStore(path)
    await fresh.upsertItem(item(2))
    await fresh.appendObservation(observation(2, 2))
    await fresh.appendActor(actor("b"))
    await fresh.putRaw({ connector: "web", ext: "txt", bytes: new Uint8Array([2]), url: "u2", fetchedAt: T, transport: "http" })
    await fresh.appendEvent("r1", { at: T, type: "two" })
    const check = async <R>(r: Reader<R>, n: number) => {
      const all = await readAll(r)
      expect(all.skipped).toBe(1)
      expect(all.records).toHaveLength(n)
    }
    await check(fresh.items(), 2)
    await check(fresh.observations(), 2)
    await check(fresh.actors(), 2)
    await check(fresh.rawIndex(), 2)
    await check(fresh.events("r1"), 2)
  })

  it("ignores a torn seen.idx tail and repairs it on lock", async () => {
    const path = await dir()
    const s = await initStore(path)
    await s.seenAdd("id:hn:1")
    await appendFile(join(path, "seen.idx"), "url:https://exa")
    const f = await openStore(path)
    expect(await f.seenKeys()).toEqual(["id:hn:1"])
    const lock = await f.acquireLock()
    expect(await readFile(join(path, "seen.idx"), "utf8")).toBe("id:hn:1\n")
    await f.seenAdd("id:hn:2")
    expect((await (await openStore(path)).seenKeys()).sort()).toEqual(["id:hn:1", "id:hn:2"])
    await lock.release()
  })

  it("reloads the seen index from disk when the lock is taken", async () => {
    const path = await dir()
    const a = await initStore(path)
    const b = await openStore(path)
    await a.seenAdd("id:hn:1")
    expect(await b.seenHas("id:hn:1")).toBe(false)
    const lock = await b.acquireLock()
    expect(await b.seenHas("id:hn:1")).toBe(true)
    await lock.release()
  })

  it("rewrites a corrupt raw file and reports stored: true", async () => {
    const path = await dir()
    const s = await initStore(path)
    const bytes = new TextEncoder().encode("payload")
    const base = { connector: "web", ext: "txt", bytes, url: "u", fetchedAt: T, transport: "http" }
    const a = await s.putRaw(base)
    const file = join(path, a.ref)
    // Independent read of the stored file.
    expect(gunzipSync(await readFile(file)).toString()).toBe("payload")
    expect((await s.putRaw(base)).stored).toBe(false)
    await writeFile(file, "not gzip at all")
    const again = await s.putRaw(base)
    expect(again.stored).toBe(true)
    expect(gunzipSync(await readFile(file)).toString()).toBe("payload")
    // A valid gzip of other bytes at the same path is wrong too.
    await writeFile(file, (await import("node:zlib")).gzipSync("other"))
    expect((await s.putRaw(base)).stored).toBe(true)
    expect(gunzipSync(await readFile(file)).toString()).toBe("payload")
    expect(new TextDecoder().decode(await s.getRaw(a.ref))).toBe("payload")
  })

  it("surfaces errors other than a missing file", async () => {
    const path = await dir()
    const s = await initStore(path)
    // `items` is a file where a directory is expected: readdir fails with ENOTDIR, not ENOENT.
    await writeFile(join(path, "items"), "x")
    await expect(readAll(s.items())).rejects.toThrow()
    await writeFile(join(path, "collect.lock"), "{}")
    await expect(s.acquireLock()).rejects.toBeInstanceOf(StoreLockedError)
  })

  it("is safe to initialise concurrently", async () => {
    const path = await dir()
    const stores = await Promise.all(Array.from({ length: 8 }, () => initStore(path)))
    expect(await Promise.all(stores.map((s) => s.schemaVersion()))).toEqual(Array(8).fill(1))
    expect(JSON.parse(await readFile(join(path, "collect.json"), "utf8"))).toEqual({ schemaVersion: 1 })
    expect((await readdir(path)).filter((n) => n.endsWith(".tmp"))).toEqual([])
  })

  it("skips and counts corrupt lines instead of crashing", async () => {
    const path = await dir()
    const s = await initStore(path)
    await s.upsertItem(item(1))
    await s.appendObservation(observation(1, 5))
    await appendFile(join(path, "items", "hn.jsonl"), "not json\n{\"id\":\"hn:2\"}\n")
    await appendFile(join(path, "observations", "hn.jsonl"), "{\"truncated\": ")
    await s.upsertItem(item(3))
    const items = await readAll((await openStore(path)).items())
    expect(items.records.map((i) => i.id)).toEqual(["hn:1", "hn:3"])
    expect(items.skipped).toBe(2)
    const obs = await readAll((await openStore(path)).observations())
    expect(obs.records).toHaveLength(1)
    expect(obs.skipped).toBe(1)
  })

  it("rebuilds seen.idx from the files and equals the live index", async () => {
    const path = await dir()
    const s = await initStore(path)
    for (let n = 1; n <= 5; n++) {
      const i = item(n)
      await s.upsertItem(i)
      for (const k of itemSeenKeys(i)) await s.seenAdd(k)
    }
    const live = (await s.seenKeys()).sort()
    await writeFile(join(path, "seen.idx"), "")
    const fresh = await openStore(path)
    expect(await fresh.seenKeys()).toEqual([])
    await fresh.rebuildSeenIndex()
    expect((await fresh.seenKeys()).sort()).toEqual(live)
    expect((await (await openStore(path)).seenKeys()).sort()).toEqual(live)
  })

  it("serialises concurrent appends", async () => {
    const path = await dir()
    const s = await initStore(path)
    await Promise.all(Array.from({ length: 50 }, (_, n) => s.appendObservation(observation(n + 1, n))))
    const { records, skipped } = await readAll(s.observations())
    expect(records).toHaveLength(50)
    expect(skipped).toBe(0)
  })
})

describe("schema versions", () => {
  it("refuses a missing store and a newer version", async () => {
    const path = await dir()
    await expect(openStore(join(path, "nope"))).rejects.toBeInstanceOf(StoreNotFoundError)
    await writeFile(join(path, "collect.json"), JSON.stringify({ schemaVersion: 99 }))
    const err = await openStore(path).catch((e) => e)
    expect(err).toBeInstanceOf(StoreVersionError)
    expect(err.message).toMatch(/newer/)
  })

  it("reads an older store through a migration hook (fake v0 fixture)", async () => {
    const path = await dir()
    // v0 layout: one flat items.jsonl at the root, no per-source split.
    await mkdir(path, { recursive: true })
    await writeFile(join(path, "collect.json"), JSON.stringify({ schemaVersion: 0 }))
    await writeFile(join(path, "items.jsonl"), `${JSON.stringify(item(1))}\n${JSON.stringify(item(2))}\n`)

    await expect(openStore(path)).rejects.toBeInstanceOf(StoreMigrationError)

    let sawLock = false
    const s = await openStore(path, {
      migrations: {
        0: async ({ root }) => {
          sawLock = (await readdir(root)).includes("collect.lock")
          await mkdir(join(root, "items"), { recursive: true })
          await writeFile(join(root, "items", "hn.jsonl"), await readFile(join(root, "items.jsonl"), "utf8"))
        },
      },
    })
    expect(sawLock).toBe(true)
    expect(await readdir(path)).not.toContain("collect.lock")
    expect(await s.schemaVersion()).toBe(1)
    expect((await readAll(s.items())).records.map((i) => i.id)).toEqual(["hn:1", "hn:2"])
    expect(JSON.parse(await readFile(join(path, "collect.json"), "utf8")).schemaVersion).toBe(1)
    await openStore(path)
  })

  it("refuses to migrate while another writer holds the lock, and re-checks the version once locked", async () => {
    const path = await dir()
    await writeFile(join(path, "collect.json"), JSON.stringify({ schemaVersion: 0 }))
    await writeFile(join(path, "collect.lock"), JSON.stringify({ pid: process.pid, at: T, host: "elsewhere", token: "t" }))
    let ran = 0
    const opts = { migrations: { 0: async () => void ran++ } }
    await expect(openStore(path, opts)).rejects.toBeInstanceOf(StoreLockedError)
    expect(ran).toBe(0)
    await rm(join(path, "collect.lock"))
    // Two openers on one v0 store: the second finds the version already current under the lock and skips the step.
    const [a, b] = await Promise.allSettled([openStore(path, opts), openStore(path, opts)])
    expect(ran).toBeLessThanOrEqual(1)
    expect([a.status, b.status].filter((x) => x === "fulfilled").length).toBeGreaterThanOrEqual(1)
    await openStore(path, opts)
    expect(ran).toBeLessThanOrEqual(1)
  })
})
