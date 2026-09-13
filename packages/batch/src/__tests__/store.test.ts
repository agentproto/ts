import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { BatchStore } from "../store.js"
import type { BatchHandle, BatchRequest, BatchResult } from "../types.js"

describe("BatchStore", () => {
  let dir: string
  let store: BatchStore

  const handle: BatchHandle = {
    id: "b_test1",
    driver: "anthropic",
    provider: { batchIds: ["msgbatch_1"] },
    createdAt: "2026-09-01T00:00:00.000Z",
    requestCount: 2,
    models: ["claude-sonnet-5"],
  }

  const requests: BatchRequest[] = [
    {
      customId: "r1",
      body: {
        model: "claude-sonnet-5",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      },
    },
    {
      customId: "r2",
      body: {
        model: "claude-sonnet-5",
        max_tokens: 10,
        messages: [{ role: "user", content: "yo" }],
      },
    },
  ]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "batch-store-"))
    store = new BatchStore({ stateDir: dir })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("returns undefined for an unknown id", async () => {
    expect(await store.load("nope")).toBeUndefined()
  })

  it("round-trips a created batch with no results yet", async () => {
    await store.create(handle, requests, { label: "test-run" })
    const record = await store.load(handle.id)
    expect(record?.handle).toEqual(handle)
    expect(record?.submitOptions).toEqual({ label: "test-run" })
    expect(record?.requests).toEqual(requests)
    expect(record?.results).toEqual([])
  })

  it("appends results and dedupes by customId on load (last write wins)", async () => {
    await store.create(handle, requests)
    const r1: BatchResult = { customId: "r1", outcome: "succeeded" }
    await store.appendResults(handle.id, [r1])
    const r1Updated: BatchResult = {
      customId: "r1",
      outcome: "errored",
      error: { type: "x", message: "later" },
    }
    const r2: BatchResult = { customId: "r2", outcome: "succeeded" }
    await store.appendResults(handle.id, [r1Updated, r2])

    const record = await store.load(handle.id)
    expect(record?.results).toHaveLength(2)
    const byId = new Map((record?.results ?? []).map(r => [r.customId, r]))
    expect(byId.get("r1")).toEqual(r1Updated)
    expect(byId.get("r2")).toEqual(r2)
  })

  it("list returns handles for every created batch", async () => {
    await store.create(handle, requests)
    const other: BatchHandle = { ...handle, id: "b_test2" }
    await store.create(other, requests)

    const handles = await store.list()
    expect(handles.map(h => h.id).sort()).toEqual(["b_test1", "b_test2"])
  })

  it("list is empty when nothing was ever created", async () => {
    expect(await store.list()).toEqual([])
  })
})
