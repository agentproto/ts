import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { CollectItem } from "@agentproto/collect"
import { openStore } from "@agentproto/collect/node"
import { type FakeServer, FAKE, KEYED, cleanStores, cli, listing, parseCsv, startServer, workdir, writeRecipe } from "./helpers"

let server: FakeServer
beforeAll(async () => {
  server = await startServer()
})
afterAll(async () => {
  await server.close()
  cleanStores()
})

const FAST = ["--rate-ms", "0"]

async function ready(name: string) {
  const dir = workdir(name)
  const store = join(dir, "store")
  expect((await cli(["init", store], { cwd: dir })).code).toBe(0)
  return { dir, store }
}

describe("init, connectors", () => {
  it("creates a store, text and json", async () => {
    const dir = workdir("init")
    const a = await cli(["init", "s1"], { cwd: dir })
    expect(a.code).toBe(0)
    expect(a.stdout).toContain("store ready")
    expect(existsSync(join(dir, "s1", "collect.json"))).toBe(true)
    const b = await cli(["init", "s1", "--json"], { cwd: dir })
    expect(b.code).toBe(0)
    expect(b.json<{ schemaVersion: number }>().schemaVersion).toBeGreaterThan(0)
  })

  it("lists an empty registry, then a loaded connector", async () => {
    const dir = workdir("connectors")
    const empty = await cli(["connectors"], { cwd: dir })
    expect(empty.code).toBe(0)
    expect(empty.stdout).toContain("no connectors")
    const loaded = await cli(["connectors", "--connector", FAKE, "--json"], { cwd: dir })
    expect(loaded.code).toBe(0)
    expect(loaded.json<Array<{ id: string }>>().map((c) => c.id)).toEqual(["fake"])
    const text = await cli(["connectors", "--connector", FAKE, "--connector", KEYED], { cwd: dir })
    expect(text.stdout).toContain("keyed")
    expect(text.stdout).toContain("key (FAKE_TOKEN)")
  })

  it("reports a connector module that cannot be loaded as a usage error", async () => {
    const dir = workdir("badmod")
    const r = await cli(["connectors", "--connector", "./nope.mjs"], { cwd: dir })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain("cannot load connector module")
  })
})

describe("doctor", () => {
  it("passes for a usable connector", async () => {
    const dir = workdir("doctor")
    const r = await cli(["doctor", "--connector", FAKE, "--source", "fake"], { cwd: dir })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("http:yes")
  })

  it("fails when the secret is missing, naming it but never its value", async () => {
    const dir = workdir("doctor-key")
    const missing = await cli(["doctor", "--connector", KEYED, "--source", "keyed"], { cwd: dir })
    expect(missing.code).toBe(1)
    expect(missing.stdout).toContain("FAKE_TOKEN: missing")
    expect(missing.stdout).toContain("not available in this version")
    const present = await cli(["doctor", "--connector", KEYED, "--source", "keyed", "--json"], { cwd: dir, env: { FAKE_TOKEN: "s3cr3t-value" } })
    expect(present.code).toBe(0)
    expect(present.stdout).not.toContain("s3cr3t-value")
    expect(present.json<{ connectors: Array<{ secretPresent: boolean }> }>().connectors[0]!.secretPresent).toBe(true)
  })

  it("fails for a connector that is not registered", async () => {
    const dir = workdir("doctor-unknown")
    const r = await cli(["doctor", "--source", "ghost"], { cwd: dir })
    expect(r.code).toBe(1)
    expect(r.stdout).toContain("not registered")
  })
})

describe("run", () => {
  it("collects, writes the store, prints a report; progress is on stderr", async () => {
    const { dir, store } = await ready("run")
    const recipe = writeRecipe(dir, server.base, ["alpha", "beta"])
    const r = await cli(["run", recipe, "--store", store, ...FAST], { cwd: dir })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("fake")
    expect(r.stdout).toContain("ok")
    expect(r.stderr).toContain("[run.start]")
    expect(r.stdout).not.toContain("[run.start]")
    const s = await openStore(store)
    const items: CollectItem[] = []
    for await (const i of s.items()) items.push(i)
    expect(items.map((i) => i.id).sort()).toEqual(["fake:alpha-1", "fake:alpha-2", "fake:beta-1", "fake:beta-2"])
    expect(items[0]!.subjects[0]!.label).toBe("topic")
  })

  it("--json prints one report document on stdout, events as JSON lines on stderr", async () => {
    const { dir, store } = await ready("run-json")
    const recipe = writeRecipe(dir, server.base, ["alpha"])
    const r = await cli(["run", recipe, "--store", store, "--json", ...FAST], { cwd: dir })
    expect(r.code).toBe(0)
    const report = r.json<{ runId: string; connectors: Array<{ newItems: number }> }>()
    expect(report.connectors[0]!.newItems).toBe(2)
    for (const line of r.stderr.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow()
    const quiet = await cli(["run", recipe, "--store", store, "--quiet", ...FAST], { cwd: dir })
    expect(quiet.stderr).toBe("")
  })

  it("exits 1 when one task fails and still writes the rest", async () => {
    const { dir, store } = await ready("partial")
    const recipe = writeRecipe(dir, server.base, ["alpha", "missing"])
    const r = await cli(["run", recipe, "--store", store, ...FAST], { cwd: dir })
    expect(r.code).toBe(1)
    expect(r.stdout).toMatch(/failures/)
    const s = await openStore(store)
    const ids: string[] = []
    for await (const i of s.items()) ids.push(i.id)
    expect(ids).toHaveLength(2)
  })

  it("exits 1 when a connector is not registered", async () => {
    const { dir, store } = await ready("unregistered")
    const recipe = join(dir, "r.yaml")
    writeFileSync(recipe, "sources:\n  - connector: ghost\n")
    const r = await cli(["run", recipe, "--store", store], { cwd: dir })
    expect(r.code).toBe(1)
    expect(r.stdout).toContain("not registered")
  })

  it("a trial run without a recipe, with --max", async () => {
    const { dir, store } = await ready("trial")
    process.env.FAKE_BASE = server.base
    const r = await cli(["run", "--connector", FAKE, "--source", "fake", "--query", "a", "--query", "b", "--subject", "s", "--max", "1", "--store", store, ...FAST, "--json"], {
      cwd: dir,
      env: { FAKE_BASE: server.base },
    })
    delete process.env.FAKE_BASE
    expect(r.code).toBe(0)
    const report = r.json<{ connectors: Array<{ tasks: { done: number } }> }>()
    expect(report.connectors[0]!.tasks.done).toBe(1)
  })

  it("--source and --query override a recipe", async () => {
    const { dir, store } = await ready("override")
    const recipe = writeRecipe(dir, server.base, ["alpha"])
    const r = await cli(["run", recipe, "--source", "fake", "--query", "gamma", "--subject", "other", "--store", store, ...FAST], { cwd: dir })
    expect(r.code).toBe(0)
    const s = await openStore(store)
    const item = await s.getItem("fake:gamma-1")
    expect(item?.subjects[0]!.label).toBe("other")
    expect(await s.getItem("fake:alpha-1")).toBeUndefined()
  })

  it("--dry-run prints the planned tasks and writes and fetches nothing", async () => {
    const { dir, store } = await ready("dry")
    const recipe = writeRecipe(dir, server.base, ["alpha", "beta"])
    const before = listing(store)
    const hits = server.hits.length
    const r = await cli(["run", recipe, "--store", store, "--dry-run"], { cwd: dir })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("2 planned tasks")
    expect(r.stdout).toContain("q-alpha")
    expect(listing(store)).toEqual(before)
    expect(server.hits.length).toBe(hits)
    const json = await cli(["run", recipe, "--dry-run", "--json", "--store", join(dir, "never-created")], { cwd: dir })
    expect(json.json<{ tasks: unknown[] }>().tasks).toHaveLength(2)
    expect(existsSync(join(dir, "never-created"))).toBe(false)
  })
})

describe("usage errors and store errors", () => {
  it("rejects bad usage with exit 2", async () => {
    const dir = workdir("usage")
    const store = join(dir, "s")
    await cli(["init", store], { cwd: dir })
    expect((await cli(["nope"], { cwd: dir })).code).toBe(2)
    expect((await cli([], { cwd: dir })).code).toBe(2)
    expect((await cli(["init"], { cwd: dir })).code).toBe(2)
    expect((await cli(["runs", "--bogus"], { cwd: dir })).code).toBe(2)
    expect((await cli(["run", "--store", store], { cwd: dir })).code).toBe(2)
    expect((await cli(["run", "--source", "fake", "--query", "x", "--store", store], { cwd: dir })).code).toBe(2)
    expect((await cli(["run", "--source", "fake", "--max", "0", "--store", store], { cwd: dir })).code).toBe(2)
    expect((await cli(["status", "ghost", "--store", store], { cwd: dir })).code).toBe(2)
    expect((await cli(["export", "--format", "xml", "--store", store], { cwd: dir })).code).toBe(2)
    const flat = await cli(["export", "--view", "flat", "--store", store], { cwd: dir })
    expect(flat.code).toBe(2)
    expect(flat.stderr).toContain("not available yet")
    expect((await cli(["reparse", "--store", store], { cwd: dir })).code).toBe(2)
  })

  it("rejects an invalid recipe, naming the path and the issue", async () => {
    const dir = workdir("badrecipe")
    const file = join(dir, "r.yaml")
    writeFileSync(file, "sources:\n  - connector: fake\n    queries:\n      - { text: a }\nworkers: -1\n")
    const r = await cli(["run", file, "--dry-run"], { cwd: dir })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain("sources[0].queries[0].subject")
    expect(r.stderr).toContain("workers")
    writeFileSync(file, "sources: [unclosed\n")
    const y = await cli(["run", file, "--dry-run"], { cwd: dir })
    expect(y.code).toBe(2)
    expect(y.stderr).toContain("invalid YAML")
    expect((await cli(["run", join(dir, "absent.yaml"), "--dry-run"], { cwd: dir })).code).toBe(2)
  })

  it("exits 3 when the store is locked, and when it does not exist", async () => {
    const { dir, store } = await ready("locked")
    const recipe = writeRecipe(dir, server.base, ["alpha"])
    const lock = await (await openStore(store)).acquireLock()
    try {
      const r = await cli(["run", recipe, "--store", store, ...FAST], { cwd: dir })
      expect(r.code).toBe(3)
      expect(r.stderr).toContain("locked")
      expect((await cli(["reparse", "--into", join(dir, "out"), "--store", store], { cwd: dir })).code).toBe(3)
    } finally {
      await lock.release()
    }
    expect((await cli(["run", recipe, "--store", store, ...FAST], { cwd: dir })).code).toBe(0)
    const none = await cli(["runs", "--store", join(dir, "absent")], { cwd: dir })
    expect(none.code).toBe(3)
    expect(none.stderr).toContain("collect init")
  })
})

describe("runs, status, resume", () => {
  it("lists runs and shows a status", async () => {
    const { dir, store } = await ready("status")
    const recipe = writeRecipe(dir, server.base, ["alpha", "missing"])
    const run = await cli(["run", recipe, "--store", store, "--json", ...FAST], { cwd: dir })
    const { runId } = run.json<{ runId: string }>()
    const runs = await cli(["runs", "--store", store, "--json"], { cwd: dir })
    expect(runs.json<Array<{ runId: string; state: string }>>()).toMatchObject([{ runId, state: "finished" }])
    expect((await cli(["runs", "--store", store], { cwd: dir })).stdout).toContain(runId)
    const st = await cli(["status", runId, "--store", store], { cwd: dir })
    expect(st.code).toBe(0)
    expect(st.stdout).toContain("done=1")
    expect(st.stdout).toContain("failed=1")
    const js = await cli(["status", runId, "--store", store, "--json"], { cwd: dir })
    expect(js.json<{ tasks: Record<string, number> }>().tasks).toMatchObject({ done: 1, failed: 1 })
  })

  it("resumes an interrupted run without fetching finished tasks again", async () => {
    const { dir, store } = await ready("resume")
    const recipe = writeRecipe(dir, server.base, ["r1", "r2", "r3"], "workers: 1\n")
    const controller = new AbortController()
    server.hits.length = 0
    server.onRequest = (_p, n) => {
      if (n === 2) controller.abort()
    }
    const first = await cli(["run", recipe, "--store", store, "--json", ...FAST], { cwd: dir, signal: controller.signal })
    server.onRequest = undefined
    expect(first.code).toBe(1)
    expect(first.json<{ interrupted: boolean }>().interrupted).toBe(true)
    const { runId } = first.json<{ runId: string }>()
    const done = (await cli(["status", runId, "--store", store, "--json"], { cwd: dir })).json<{ tasks: Record<string, number> }>().tasks.done ?? 0
    expect(done).toBeGreaterThan(0)
    expect(done).toBeLessThan(3)
    server.hits.length = 0

    const resumed = await cli(["resume", runId, "--store", store, "--json", ...FAST], { cwd: dir })
    expect(resumed.code).toBe(0)
    expect(server.hits.length).toBe(3 - done)
    expect(new Set(server.hits).size).toBe(3 - done)
    const s = await openStore(store)
    let n = 0
    for await (const _ of s.items()) n++
    expect(n).toBe(6)
    expect((await cli(["resume", "ghost", "--store", store], { cwd: dir })).code).toBe(2)
  })
})

describe("export", () => {
  async function populated(name: string) {
    const { dir, store } = await ready(name)
    const recipe = writeRecipe(dir, server.base, ["alpha", "beta"])
    await cli(["run", recipe, "--store", store, ...FAST], { cwd: dir })
    return { dir, store }
  }

  it("writes JSONL that parses back to the stored items", async () => {
    const { dir, store } = await populated("export-jsonl")
    const r = await cli(["export", "--store", store], { cwd: dir })
    expect(r.code).toBe(0)
    const items = r.stdout.trim().split("\n").map((l) => CollectItem.parse(JSON.parse(l)))
    const s = await openStore(store)
    const stored: CollectItem[] = []
    for await (const i of s.items()) stored.push(i)
    expect(items).toEqual(stored)
    const filtered = await cli(["export", "--store", store, "--source", "nothing"], { cwd: dir })
    expect(filtered.stdout).toBe("")
  })

  it("writes CSV that reads back to the same items, and --out", async () => {
    const { dir, store } = await populated("export-csv")
    const out = join(dir, "items.csv")
    const r = await cli(["export", "--store", store, "--format", "csv", "--out", out, "--json"], { cwd: dir })
    expect(r.code).toBe(0)
    expect(r.json<{ items: number }>().items).toBe(4)
    const rows = parseCsv(readFileSync(out, "utf8"))
    const [header, ...body] = rows
    expect(body).toHaveLength(4)
    const s = await openStore(store)
    const byId = new Map<string, CollectItem>()
    for await (const i of s.items()) byId.set(i.id, i)
    for (const row of body) {
      const rec = Object.fromEntries(header!.map((h, i) => [h, row[i]!]))
      const item = byId.get(rec.id!)!
      expect(rec.text).toBe(item.text)
      expect(rec.text).toContain('"quotes"\nand')
      expect(JSON.parse(rec.subjects!)).toEqual(item.subjects)
      expect(rec.firstSeenAt).toBe(item.firstSeenAt)
      expect(rec.canonicalUrl).toBe(item.canonicalUrl)
    }
  })
})

describe("reparse", () => {
  it("rebuilds the same items from the raws without touching the source store", async () => {
    const { dir, store } = await ready("reparse")
    const recipe = writeRecipe(dir, server.base, ["alpha", "beta", "missing"])
    await cli(["run", recipe, "--store", store, ...FAST], { cwd: dir })
    const before = listing(store)
    const itemsFile = readFileSync(join(store, "items", "fake.jsonl"), "utf8")
    const hits = server.hits.length

    const into = join(dir, "rebuilt")
    const r = await cli(["reparse", "--into", into, "--connector", FAKE, "--store", store, "--json"], { cwd: dir })
    expect(r.code).toBe(0)
    expect(r.json<{ items: number; failedRaws: number }>()).toMatchObject({ items: 4, failedRaws: 1 })
    expect(server.hits.length).toBe(hits)
    expect(listing(store)).toEqual(before)
    expect(readFileSync(join(store, "items", "fake.jsonl"), "utf8")).toBe(itemsFile)

    const read = async (path: string) => {
      const s = await openStore(path)
      const items: CollectItem[] = []
      for await (const i of s.items()) items.push(i)
      const observations: unknown[] = []
      for await (const o of s.observations()) observations.push(o)
      const actors: unknown[] = []
      for await (const a of s.actors()) actors.push(a)
      return { items: items.sort((a, b) => a.id.localeCompare(b.id)), observations: observations.length, actors: actors.length }
    }
    const a = await read(store)
    const b = await read(into)
    expect(b.items).toEqual(a.items)
    expect(b.observations).toBe(a.observations)
    expect(b.actors).toBe(a.actors)
    expect(await (await openStore(into)).getRaw((a.items[0]!.rawRefs ?? [])[0]!)).toBeDefined()
  })

  it("refuses a non-empty target and reports connectors it cannot find", async () => {
    const { dir, store } = await ready("reparse-guard")
    const recipe = writeRecipe(dir, server.base, ["alpha"])
    await cli(["run", recipe, "--store", store, ...FAST], { cwd: dir })
    const taken = join(dir, "taken")
    await cli(["init", taken], { cwd: dir })
    expect((await cli(["reparse", "--into", taken, "--connector", FAKE, "--store", store], { cwd: dir })).code).toBe(2)
    expect((await cli(["reparse", "--into", store, "--store", store], { cwd: dir })).code).toBe(2)
    const nofake = await cli(["reparse", "--into", join(dir, "o2"), "--store", store], { cwd: dir })
    expect(nofake.code).toBe(1)
    expect(nofake.stderr).toContain('connector "fake" is not registered')
  })
})
