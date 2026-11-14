import { afterEach, describe, expect, it, vi } from "vitest"

import { createDeliveryBatcher } from "../batch.js"

interface Flush {
  target: string
  items: readonly string[]
}

function recorder() {
  const flushes: Flush[] = []
  return {
    flushes,
    flush: (target: string, items: readonly string[]): void => {
      flushes.push({ target, items: [...items] })
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("createDeliveryBatcher", () => {
  it("coalesces a burst for one target into a single flush after batchMs", async () => {
    vi.useFakeTimers()
    const rec = recorder()
    const batcher = createDeliveryBatcher<string>({ flush: rec.flush })

    void batcher.enqueue("sess_1", 100, "a")
    void batcher.enqueue("sess_1", 100, "b")
    void batcher.enqueue("sess_1", 100, "c")
    expect(batcher.pending()).toEqual(["sess_1"])
    expect(rec.flushes).toEqual([])

    await vi.advanceTimersByTimeAsync(100)

    expect(rec.flushes).toEqual([{ target: "sess_1", items: ["a", "b", "c"] }])
    expect(batcher.pending()).toEqual([])
    batcher.dispose()
  })

  it("keeps batches per target", async () => {
    vi.useFakeTimers()
    const rec = recorder()
    const batcher = createDeliveryBatcher<string>({ flush: rec.flush })

    void batcher.enqueue("sess_1", 100, "a")
    void batcher.enqueue("sess_2", 100, "b")
    void batcher.enqueue("sess_1", 100, "c")

    await vi.advanceTimersByTimeAsync(100)

    expect(rec.flushes).toEqual([
      { target: "sess_1", items: ["a", "c"] },
      { target: "sess_2", items: ["b"] },
    ])
    batcher.dispose()
  })

  it("batchMs 0 delivers each item immediately", async () => {
    vi.useFakeTimers()
    const rec = recorder()
    const batcher = createDeliveryBatcher<string>({ flush: rec.flush })

    await batcher.enqueue("sess_1", 0, "a")
    await batcher.enqueue("sess_1", 0, "b")

    expect(rec.flushes).toEqual([
      { target: "sess_1", items: ["a"] },
      { target: "sess_1", items: ["b"] },
    ])
    batcher.dispose()
  })

  it("flush() delivers the open window early", async () => {
    vi.useFakeTimers()
    const rec = recorder()
    const batcher = createDeliveryBatcher<string>({ flush: rec.flush })

    void batcher.enqueue("sess_1", 60_000, "a")
    await batcher.flush("sess_1")

    expect(rec.flushes).toEqual([{ target: "sess_1", items: ["a"] }])
    batcher.dispose()
  })

  it("a throwing flush reports through onError and drops the batch", async () => {
    vi.useFakeTimers()
    const errors: Array<{ target: string; items: readonly string[]; message: string }> = []
    const batcher = createDeliveryBatcher<string>({
      flush: () => {
        throw new Error("boom")
      },
      onError: (target, items, error) => {
        errors.push({ target, items: [...items], message: (error as Error).message })
      },
    })

    void batcher.enqueue("sess_1", 100, "a")
    await vi.advanceTimersByTimeAsync(100)

    expect(errors).toEqual([{ target: "sess_1", items: ["a"], message: "boom" }])
    expect(batcher.pending()).toEqual([])
    batcher.dispose()
  })

  it("dispose drops pending batches without delivering", async () => {
    vi.useFakeTimers()
    const rec = recorder()
    const batcher = createDeliveryBatcher<string>({ flush: rec.flush })

    void batcher.enqueue("sess_1", 100, "a")
    batcher.dispose()
    await vi.advanceTimersByTimeAsync(100)

    expect(rec.flushes).toEqual([])
    expect(batcher.pending()).toEqual([])
  })
})
