/**
 * Coverage for the catalog-snapshot store — round-trip persistence against an
 * injected temp `dir`, and the "never throw on read" tolerances (missing
 * file, corrupt file, schema mismatch).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  loadCatalogSnapshotStore,
  recordCatalogSnapshot,
} from "../catalog-snapshot-store.js"
import type { CatalogSnapshot } from "../catalog-diff-stub.js"

function entry(inputPer1M: number, outputPer1M: number): CatalogSnapshot[string] {
  return { id: "x", inputPer1M, outputPer1M, free: inputPer1M === 0 && outputPer1M === 0 }
}

describe("catalog-snapshot-store", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "catalog-snapshot-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("round-trips record → load against an injected dir", async () => {
    const snapshot: CatalogSnapshot = { "gpt-x": { ...entry(1, 2), id: "gpt-x" } }
    await recordCatalogSnapshot(snapshot, { dir })
    const read = await loadCatalogSnapshotStore({ dir })
    expect(read.version).toBe(1)
    expect(read.snapshot).toEqual(snapshot)
    expect(new Date(read.asOf).getTime()).not.toBeNaN()
  })

  it("overwrites the whole snapshot on each record", async () => {
    await recordCatalogSnapshot({ a: { ...entry(1, 2), id: "a" } }, { dir })
    await recordCatalogSnapshot({ b: { ...entry(3, 4), id: "b" } }, { dir })
    const read = await loadCatalogSnapshotStore({ dir })
    expect(Object.keys(read.snapshot)).toEqual(["b"])
  })

  it("missing file → empty store (no throw)", async () => {
    const read = await loadCatalogSnapshotStore({ dir })
    expect(read).toEqual({ version: 1, snapshot: {}, asOf: "1970-01-01T00:00:00.000Z" })
  })

  it("corrupt file → empty store (no throw)", async () => {
    await writeFile(join(dir, "catalog-snapshot.json"), "{ not valid json ", "utf8")
    const read = await loadCatalogSnapshotStore({ dir })
    expect(read.snapshot).toEqual({})
  })

  it("schema-mismatched file → empty store (no throw)", async () => {
    await writeFile(
      join(dir, "catalog-snapshot.json"),
      JSON.stringify({ version: 2, snapshot: {} }),
      "utf8",
    )
    const read = await loadCatalogSnapshotStore({ dir })
    expect(read).toEqual({ version: 1, snapshot: {}, asOf: "1970-01-01T00:00:00.000Z" })
  })
})
