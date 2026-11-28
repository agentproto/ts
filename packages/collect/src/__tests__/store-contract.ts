import { describe, expect, it } from "vitest"
import { StoreLockedError, itemSeenKeys, readAll, seenKey, type CollectStore } from "../index"
import { actor, item, observation, pickup, recipe, T } from "./helpers"

/** Behaviour every `CollectStore` must have. `make` returns a store plus a way to reopen it from scratch. */
export function storeContract(
  name: string,
  make: () => Promise<{ store: CollectStore; reopen?: () => Promise<CollectStore>; cleanup: () => Promise<void> }>,
) {
  describe(`CollectStore contract: ${name}`, () => {
    async function withStore(fn: (s: CollectStore, reopen: () => Promise<CollectStore>) => Promise<void>) {
      const h = await make()
      try {
        await fn(h.store, h.reopen ?? (async () => h.store))
      } finally {
        await h.cleanup()
      }
    }

    it("upserts items, last write wins, and re-reads identically", () =>
      withStore(async (s, reopen) => {
        await s.upsertItem(item(1, { title: "first" }))
        await s.upsertItem(item(2))
        await s.upsertItem(item(1, { title: "second" }))
        const fresh = await reopen()
        const { records, skipped } = await readAll(fresh.items())
        expect(skipped).toBe(0)
        expect(records).toHaveLength(2)
        expect(records.find((i) => i.id === "hn:1")?.title).toBe("second")
        expect(await fresh.getItem("hn:1")).toEqual(records.find((i) => i.id === "hn:1"))
        expect(await fresh.getItem("hn:99")).toBeUndefined()
        expect((await readAll(fresh.items("nope"))).records).toEqual([])
      }))

    it("appends observations, actors and pickups and reads them back deep-equal", () =>
      withStore(async (s, reopen) => {
        await s.appendObservation(observation(1, 10))
        await s.appendObservation(observation(1, 20))
        await s.appendActor(actor("alice"))
        await s.appendPickup(pickup(1))
        const f = await reopen()
        expect((await readAll(f.observations())).records).toEqual([observation(1, 10), observation(1, 20)])
        expect((await readAll(f.observations("hn"))).records).toHaveLength(2)
        expect((await readAll(f.observations("x"))).records).toHaveLength(0)
        expect((await readAll(f.actors())).records).toEqual([{ ref: "hn:alice", audience: [] }])
        expect((await readAll(f.pickups())).records).toEqual([pickup(1)])
      }))

    it("rejects invalid records on write", () =>
      withStore(async (s) => {
        await expect(s.upsertItem({ ...item(1), kind: "bogus" } as never)).rejects.toThrow()
        await expect(s.appendObservation({ itemId: "hn:1", measuredAt: "nope", metrics: {} })).rejects.toThrow()
      }))

    it("stores a raw once per path and indexes every fetch", () =>
      withStore(async (s, reopen) => {
        const bytes = new TextEncoder().encode("<html>same</html>")
        const base = { connector: "web", ext: "html", bytes, url: "https://example.com/a", transport: "http" }
        const a = await s.putRaw({ ...base, fetchedAt: T, httpStatus: 200, runId: "r1" })
        const b = await s.putRaw({ ...base, fetchedAt: "2026-11-28T11:00:00Z", httpStatus: 200, runId: "r2" })
        const c = await s.putRaw({ ...base, bytes: new Uint8Array(), fetchedAt: T, httpStatus: 403, failure: "blocked" })
        expect(a.stored).toBe(true)
        expect(b.stored).toBe(false)
        expect(b.ref).toBe(a.ref)
        expect(a.ref).toMatch(/^raw\/web\/2026-11\/[0-9a-f]{64}\.html\.gz$/)
        expect(c.stored).toBe(true)
        const f = await reopen()
        expect(new TextDecoder().decode(await f.getRaw(a.ref))).toBe("<html>same</html>")
        const index = (await readAll(f.rawIndex())).records
        expect(index).toHaveLength(3)
        expect(index.map((e) => e.runId)).toEqual(["r1", "r2", undefined])
        expect(index[2]).toMatchObject({ httpStatus: 403, failure: "blocked", bytes: 0 })
        expect(await f.getRaw(`raw/web/2026-11/${"0".repeat(64)}.html.gz`)).toBeUndefined()
      }))

    it("rejects unsafe path segments", () =>
      withStore(async (s) => {
        await expect(
          s.putRaw({ connector: "../x", ext: "html", bytes: new Uint8Array(), url: "u", fetchedAt: T, transport: "http" }),
        ).rejects.toThrow()
        await expect(s.createRun("../evil", recipe)).rejects.toThrow()
      }))

    it("tracks seen keys and rebuilds them from the items", () =>
      withStore(async (s, reopen) => {
        const items = [item(1), item(2), item(3, { canonicalUrl: undefined })]
        for (const i of items) {
          await s.upsertItem(i)
          for (const k of itemSeenKeys(i)) await s.seenAdd(k)
        }
        await s.seenAdd(seenKey("id", "hn:1"))
        expect(await s.seenHas(seenKey("id", "hn:2"))).toBe(true)
        expect(await s.seenHas(seenKey("url", "https://example.com/9"))).toBe(false)
        const live = (await s.seenKeys()).sort()
        await s.rebuildSeenIndex()
        expect((await s.seenKeys()).sort()).toEqual(live)
        expect((await (await reopen()).seenKeys()).sort()).toEqual(live)
      }))

    it("keeps run records: recipe + hash, tasks (last state wins), sampling, events, report", () =>
      withStore(async (s, reopen) => {
        const rec = await s.createRun("run1", recipe)
        expect(rec.recipeHash).toMatch(/^[0-9a-f]{64}$/)
        await expect(s.createRun("run1", recipe)).rejects.toThrow(/already exists/)
        await s.appendTask("run1", { taskId: "t1", connector: "hn", status: "pending", updatedAt: T })
        await s.appendTask("run1", { taskId: "t2", connector: "hn", status: "pending", updatedAt: T })
        await s.appendTask("run1", { taskId: "t1", connector: "hn", status: "done", transport: "http", updatedAt: T })
        await s.appendSampling("run1", { candidate: "hn:1", decision: "dropped", rule: "band", at: T })
        await s.appendEvent("run1", { at: T, type: "task:done", data: { taskId: "t1" } })
        const report = { runId: "run1", startedAt: T, connectors: [] }
        await s.writeReport("run1", report)
        const f = await reopen()
        expect(await f.getRun("run1")).toEqual(rec)
        expect(await f.getRun("zzz")).toBeUndefined()
        expect(await f.listRuns()).toEqual(["run1"])
        const tasks = (await readAll(f.tasks("run1"))).records
        expect(tasks.map((t) => [t.taskId, t.status])).toEqual([
          ["t1", "done"],
          ["t2", "pending"],
        ])
        expect((await readAll(f.sampling("run1"))).records).toHaveLength(1)
        expect((await readAll(f.events("run1"))).records[0]?.type).toBe("task:done")
        expect(await f.readReport("run1")).toEqual(report)
        expect(await f.readReport("none")).toBeUndefined()
      }))

    it("refuses a second lock and allows one again after release", () =>
      withStore(async (s) => {
        const lock = await s.acquireLock()
        await expect(s.acquireLock()).rejects.toBeInstanceOf(StoreLockedError)
        await lock.release()
        await lock.release()
        const again = await s.acquireLock()
        await again.release()
      }))

    it("reports the current schema version", () =>
      withStore(async (s) => {
        expect(await s.schemaVersion()).toBe(1)
      }))
  })
}
