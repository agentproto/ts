/**
 * DurableRowFile: the shared keyed-row store mechanics extracted from the
 * sentinel webhook outbox. Covers load filtering, durable atomic writes, the
 * serialized chain and its generation guard, debounced writes, rollback on a
 * failed insert, and terminal-row selection.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createDurableRowFile,
  oldestTerminalKey,
  type DurableRowFileOptions,
} from "../durable-row-file.js"

interface Row {
  id: string
  status: "pending" | "done"
  createdAt: number
  terminalAt?: number
}

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "durable-row-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const acceptLoaded = (value: unknown): readonly [string, Row] | undefined => {
  const row = value as Row
  return typeof row?.id === "string" ? ([row.id, row] as const) : undefined
}

function make(filePath: string, over: Partial<DurableRowFileOptions<Row>> = {}) {
  const logs: string[] = []
  const store = createDurableRowFile<Row>({
    filePath,
    persist: true,
    debounceMs: 1_500,
    log: line => logs.push(line),
    logPrefix: "[test-store]",
    acceptLoaded,
    ...over,
  })
  return { store, logs }
}

const row = (id: string, createdAt: number, over: Partial<Row> = {}): Row => ({
  id,
  status: "pending",
  createdAt,
  ...over,
})

const isTerminal = (r: Row): boolean => r.status === "done"
const terminalAt = (r: Row): number => r.terminalAt ?? r.createdAt
const retention = (rows: ReadonlyMap<string, Row>, cap: number) => ({
  cap,
  oldestTerminalKey: () => oldestTerminalKey(rows, isTerminal, terminalAt),
})

describe("durable row file load", () => {
  it("a missing file is silent and starts empty", () => {
    const { store, logs } = make(join(tmp(), "store.json"))
    expect(store.rows.size).toBe(0)
    expect(logs).toEqual([])
  })

  it("a corrupt file logs the prefixed message and starts empty", () => {
    const file = join(tmp(), "store.json")
    writeFileSync(file, "{not json")
    const { store, logs } = make(file)
    expect(store.rows.size).toBe(0)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/^\[test-store\] corrupt file, starting empty: /)
  })

  it("an unreadable path (a directory) logs the read failure and starts empty", () => {
    const file = join(tmp(), "store.json")
    mkdirSync(file)
    const { store, logs } = make(file)
    expect(store.rows.size).toBe(0)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/^\[test-store\] read failed, starting empty: /)
  })

  it("acceptLoaded filters values and rebuilds keys from the row", () => {
    const file = join(tmp(), "store.json")
    writeFileSync(
      file,
      JSON.stringify({
        "stored-key-that-is-not-trusted": row("a", 1),
        bad: { nope: true },
      }),
    )
    const { store } = make(file)
    expect([...store.rows.keys()]).toEqual(["a"])
  })
})

describe("durable row file persistence", () => {
  it("persistNow writes pretty JSON with a trailing newline and mode 0600", async () => {
    const file = join(tmp(), "store.json")
    const { store } = make(file)
    store.rows.set("k", row("k", 1))
    await store.persistNow()

    expect(readFileSync(file, "utf8")).toBe(`${JSON.stringify({ k: row("k", 1) }, null, 2)}\n`)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it("two overlapping persistNow calls end with the newer snapshot on disk", async () => {
    const file = join(tmp(), "store.json")
    const { store } = make(file)
    store.rows.set("a", row("a", 1))

    const first = store.persistNow()
    await Promise.resolve()
    store.rows.set("b", row("b", 2))
    const second = store.persistNow()

    await Promise.all([first, second])
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")) as Record<string, Row>)).toEqual(["a", "b"])
  })

  it("flushSync wins over an in-flight async write via the generation guard", async () => {
    const file = join(tmp(), "store.json")
    const { store } = make(file)
    store.rows.set("a", row("a", 1))

    const write = store.persistNow()
    await Promise.resolve()
    store.rows.set("b", row("b", 2))
    store.flushSync()
    await write

    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")) as Record<string, Row>)).toEqual(["a", "b"])
  })

  it("schedulePersist coalesces calls into one debounced write", async () => {
    vi.useFakeTimers()
    const file = join(tmp(), "store.json")
    const { store } = make(file, { debounceMs: 100 })
    store.rows.set("a", row("a", 1))

    const stringify = vi.spyOn(JSON, "stringify")
    store.schedulePersist()
    store.schedulePersist()
    store.schedulePersist()
    expect(existsSync(file)).toBe(false)

    await vi.advanceTimersByTimeAsync(99)
    expect(existsSync(file)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await store.settled()

    expect(stringify).toHaveBeenCalledTimes(1)
    expect(existsSync(file)).toBe(true)
  })

  it("schedulePersist logs persist failed when the write fails", async () => {
    vi.useFakeTimers()
    const dir = tmp()
    const blocker = join(dir, "blocker")
    writeFileSync(blocker, "x")
    const { store, logs } = make(join(blocker, "store.json"), { debounceMs: 100 })
    store.rows.set("a", row("a", 1))

    store.schedulePersist()
    await vi.advanceTimersByTimeAsync(100)
    await store.settled()

    expect(logs.some(line => /^\[test-store\] persist failed: /.test(line))).toBe(true)
  })

  it("persist:false never creates the file", async () => {
    const file = join(tmp(), "store.json")
    const { store } = make(file, { persist: false })
    store.rows.set("a", row("a", 1))
    await store.persistNow()
    store.schedulePersist()
    store.flushSync()
    await store.insertDurable("b", row("b", 2), retention(store.rows, 10))
    expect(existsSync(file)).toBe(false)
  })
})

describe("insertDurable", () => {
  it("evicts the oldest terminal row at the cap", async () => {
    const file = join(tmp(), "store.json")
    const { store } = make(file)
    store.rows.set("old", row("old", 1, { status: "done", terminalAt: 1 }))
    store.rows.set("newer", row("newer", 2, { status: "done", terminalAt: 2 }))

    await store.insertDurable("fresh", row("fresh", 3), retention(store.rows, 2))

    expect([...store.rows.keys()]).toEqual(["newer", "fresh"])
  })

  it("rolls back the insert and the eviction on persist failure, then rethrows", async () => {
    const dir = tmp()
    const blocker = join(dir, "blocker")
    writeFileSync(blocker, "x")
    const { store } = make(join(blocker, "store.json"))
    store.rows.set("old", row("old", 1, { status: "done", terminalAt: 1 }))

    await expect(store.insertDurable("fresh", row("fresh", 2), retention(store.rows, 1))).rejects.toBeInstanceOf(Error)

    expect([...store.rows.keys()]).toEqual(["old"])
    expect(store.rows.get("fresh")).toBeUndefined()
  })
})

describe("oldestTerminalKey", () => {
  it("picks the oldest terminal row by terminalAt and ignores non-terminal rows", () => {
    const rows = new Map<string, Row>([
      ["pending", row("pending", 0)],
      ["later", row("later", 4, { status: "done", terminalAt: 5 })],
      ["earlier", row("earlier", 1, { status: "done", terminalAt: 2 })],
    ])
    expect(oldestTerminalKey(rows, isTerminal, terminalAt)).toBe("earlier")
  })
})
