import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { StoreLockedError, StoreVersionError, itemSeenKeys, readAll } from "../index"
import { StoreMigrationError, StoreNotFoundError, initStore, openStore } from "../node"
import { actor, item, observation, recipe, T, testDir } from "./helpers"
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

    const s = await openStore(path, {
      migrations: {
        0: async ({ root }) => {
          await mkdir(join(root, "items"), { recursive: true })
          await writeFile(join(root, "items", "hn.jsonl"), await readFile(join(root, "items.jsonl"), "utf8"))
        },
      },
    })
    expect(await s.schemaVersion()).toBe(1)
    expect((await readAll(s.items())).records.map((i) => i.id)).toEqual(["hn:1", "hn:2"])
    expect(JSON.parse(await readFile(join(path, "collect.json"), "utf8")).schemaVersion).toBe(1)
    await openStore(path)
  })
})
