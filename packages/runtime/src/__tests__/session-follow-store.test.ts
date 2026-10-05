import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSessionFollowStore,
  DEFAULT_FOLLOW_BATCH_MS,
  FOLLOW_EVENTS,
} from "../session-follow-store.js"

describe("session-follow-store", () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "follow-store-"))
    file = join(dir, "follows.json")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("resolves the documented defaults", () => {
    const store = createSessionFollowStore({ persist: false })
    const { follow, created } = store.upsert({ follower: "chief", selector: { all: true } })
    expect(created).toBe(true)
    expect(follow.id).toMatch(/^fol_/)
    expect(follow.events).toEqual([...FOLLOW_EVENTS])
    expect(follow.batchMs).toBe(DEFAULT_FOLLOW_BATCH_MS)
    expect(follow.batchMs).toBe(15_000)
    expect(follow.skipEmptyTurns).toBe(true)
    expect(follow.excludeFollowerChildren).toBe(true)
    expect(follow.selector.rootOnly).toBe(true) // all => rootOnly
    expect(Number.isNaN(Date.parse(follow.createdAt))).toBe(false)
  })

  it("rootOnly defaults to false without `all`, and an explicit value wins", () => {
    const store = createSessionFollowStore({ persist: false })
    expect(store.upsert({ follower: "c", selector: { cwdPrefix: "/x" } }).follow.selector.rootOnly).toBe(false)
    expect(store.upsert({ follower: "c", selector: { all: true, rootOnly: false } }).follow.selector.rootOnly).toBe(false)
  })

  it("upsert by key keeps id + createdAt and replaces the rest", () => {
    let t = 1_000
    const store = createSessionFollowStore({ persist: false, nowMs: () => (t += 1000) })
    const a = store.upsert({ key: "k", follower: "c", selector: { all: true }, batchMs: 100 })
    const b = store.upsert({ key: "k", follower: "c", selector: { sessionIds: ["x"] }, batchMs: 200 })
    expect(a.created).toBe(true)
    expect(b.created).toBe(false)
    expect(b.follow.id).toBe(a.follow.id)
    expect(b.follow.createdAt).toBe(a.follow.createdAt)
    expect(b.follow.batchMs).toBe(200)
    expect(b.follow.selector.sessionIds).toEqual(["x"])
    expect(store.list()).toHaveLength(1)
  })

  it("without a key every upsert creates a new follow", () => {
    const store = createSessionFollowStore({ persist: false })
    store.upsert({ follower: "c", selector: { all: true } })
    store.upsert({ follower: "c", selector: { all: true } })
    expect(store.list()).toHaveLength(2)
  })

  it("finds / removes by id or key; list filters by follower", () => {
    const store = createSessionFollowStore({ persist: false })
    const a = store.upsert({ key: "ka", follower: "c1", selector: { all: true } }).follow
    const b = store.upsert({ follower: "c2", selector: { all: true } }).follow
    expect(store.find("ka")?.id).toBe(a.id)
    expect(store.find(a.id)?.id).toBe(a.id)
    expect(store.list({ follower: "c2" }).map(f => f.id)).toEqual([b.id])
    expect(store.remove("ka")?.id).toBe(a.id)
    expect(store.remove("ka")).toBeUndefined()
    expect(store.remove(b.id)?.id).toBe(b.id)
    expect(store.list()).toEqual([])
  })

  it("dedupes ids/labels and drops empty exclude", () => {
    const store = createSessionFollowStore({ persist: false })
    const f = store.upsert({
      follower: "c",
      selector: { sessionIds: ["a", "a", "b"] },
      exclude: { sessionIds: ["x", "x"], labels: [] },
    }).follow
    expect(f.selector.sessionIds).toEqual(["a", "b"])
    expect(f.exclude).toEqual({ sessionIds: ["x"] })
    expect(store.upsert({ follower: "c", selector: { all: true }, exclude: {} }).follow.exclude).toBeUndefined()
  })

  it("setFollower re-points a follow", () => {
    const store = createSessionFollowStore({ persist: false })
    const f = store.upsert({ follower: "old", selector: { all: true } }).follow
    expect(store.setFollower(f.id, "new")?.follower).toBe("new")
    expect(store.get(f.id)?.follower).toBe("new")
    expect(store.setFollower("nope", "x")).toBeUndefined()
  })

  it("persists and reloads (round trip, mode 0600)", () => {
    const store = createSessionFollowStore({ filePath: file })
    const f = store.upsert({
      key: "k",
      follower: "chief",
      selector: { all: true, cwdPrefix: "/w" },
      exclude: { labels: ["judge"] },
      events: ["exited", "crashed"],
      batchMs: 0,
      skipEmptyTurns: false,
    }).follow
    store.flushSync()
    expect(statSync(file).mode & 0o777).toBe(0o600)

    const reloaded = createSessionFollowStore({ filePath: file })
    expect(reloaded.list()).toEqual([f])
    expect(reloaded.find("k")).toEqual(f)

    reloaded.remove("k")
    reloaded.flushSync()
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({})
  })

  it("a follow whose follower is gone is still stored (no registry coupling)", () => {
    const store = createSessionFollowStore({ filePath: file })
    store.upsert({ follower: "dead-session", selector: { all: true } })
    store.flushSync()
    expect(createSessionFollowStore({ filePath: file }).list()[0]?.follower).toBe("dead-session")
  })

  it("a corrupt file starts empty instead of throwing", () => {
    writeFileSync(file, "{not json")
    expect(createSessionFollowStore({ filePath: file }).list()).toEqual([])
  })
})
