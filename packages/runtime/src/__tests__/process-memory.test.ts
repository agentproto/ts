import { describe, expect, it } from "vitest"
import { processTreeRss } from "../process-memory.js"

/** Canned `ps -A -o pid=,ppid=,rss=` output, macOS/Linux-shaped (leading
 *  whitespace on some columns, as real `ps` emits). */
const PS_OUTPUT = [
  "    1     0   1000",
  "  100     1   2000", // root A
  "  101   100   3000", // A's child
  "  102   101   4000", // A's grandchild
  "  200     1   5000", // root B, no children
  "  999   999   9999", // unrelated row, self-parented (must never loop)
].join("\n")

describe("processTreeRss", () => {
  it("sums a 3-level tree's RSS (KiB→bytes) under its root", async () => {
    const result = await processTreeRss([100], () => Promise.resolve(PS_OUTPUT))
    // 2000 + 3000 + 4000 = 9000 KiB
    expect(result.get(100)).toBe(9000 * 1024)
  })

  it("reports a leaf root as just its own RSS", async () => {
    const result = await processTreeRss([200], () => Promise.resolve(PS_OUTPUT))
    expect(result.get(200)).toBe(5000 * 1024)
  })

  it("omits a root pid ps never reported, rather than reporting 0", async () => {
    const result = await processTreeRss([100, 424242], () => Promise.resolve(PS_OUTPUT))
    expect(result.has(424242)).toBe(false)
    expect(result.get(100)).toBe(9000 * 1024)
  })

  it("returns an empty map when the ps call fails (never throws)", async () => {
    const result = await processTreeRss([100], () => Promise.reject(new Error("spawn ps ENOENT")))
    expect(result.size).toBe(0)
  })

  it("returns an empty map for an empty input without invoking the executor", async () => {
    let called = false
    const result = await processTreeRss([], () => {
      called = true
      return Promise.resolve(PS_OUTPUT)
    })
    expect(result.size).toBe(0)
    expect(called).toBe(false)
  })

  it("never infinite-loops on a self-parented row", async () => {
    const result = await processTreeRss([999], () => Promise.resolve(PS_OUTPUT))
    expect(result.get(999)).toBe(9999 * 1024)
  })
})
