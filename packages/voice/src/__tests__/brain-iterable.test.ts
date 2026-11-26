import { describe, expect, it } from "vitest"
import { deltasToIterable } from "../brain-iterable.js"

const collect = async (it: AsyncIterable<string>) => {
  const out: string[] = []
  for await (const d of it) out.push(d)
  return out
}

describe("deltasToIterable", () => {
  it("yields deltas in order", async () => {
    const out = await collect(
      deltasToIterable(async on => {
        on("a")
        await Promise.resolve()
        on("b")
        on("c")
        return "abc"
      }),
    )
    expect(out).toEqual(["a", "b", "c"])
  })

  it("speaks a one-block answer when no delta was pushed", async () => {
    expect(await collect(deltasToIterable(async () => "whole"))).toEqual(["whole"])
    expect(await collect(deltasToIterable(async () => "  "))).toEqual([])
  })

  it("surfaces a failure after the queued deltas", async () => {
    const it = deltasToIterable(async on => {
      on("x")
      throw new Error("boom")
    })
    const got: string[] = []
    await expect(
      (async () => {
        for await (const d of it) got.push(d)
      })(),
    ).rejects.toThrow("boom")
    expect(got).toEqual(["x"])
  })

  it("does not start before iteration", () => {
    let started = false
    deltasToIterable(async () => {
      started = true
    })
    expect(started).toBe(false)
  })
})
