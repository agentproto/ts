import { describe, it, expect } from "vitest"
import { captureToGoal } from "../goal.js"
import { resolveDepth, DEPTH_PROFILES } from "../depth.js"
import type { SocialSourcePort, CaptureOptions } from "../ports/social-source.port.js"
import type { FootprintRecord } from "../model/footprint.js"

/** A fake adapter that streams N posts then M connections, honoring the abort
 *  signal between yields (like a real adapter checks between pages). */
function fakeAdapter(posts: number, connections: number): SocialSourcePort {
  return {
    platform: "x",
    slices: [],
    async *capture(handle: string, opts: CaptureOptions): AsyncIterable<FootprintRecord> {
      yield { kind: "profile", platform: "x", handle }
      for (let i = 0; i < posts; i++) {
        if (opts.signal?.aborted) return
        yield { kind: "post", subtype: "post", platform: "x", urn: `x:${i}`, authorHandle: handle, text: `p${i}` }
      }
      for (let i = 0; i < connections; i++) {
        if (opts.signal?.aborted) return
        yield { kind: "connection", platform: "x", direction: "following", edge: "FOLLOWS", person: { platform: "x", handle: `c${i}` } }
      }
    },
  }
}

describe("resolveDepth", () => {
  it("resolves names, overrides, and defaults", () => {
    expect(resolveDepth("deep")).toEqual(DEPTH_PROFILES.deep)
    expect(resolveDepth()).toEqual(DEPTH_PROFILES.standard)
    expect(resolveDepth({ limit: 7 }).limit).toBe(7)
    expect(resolveDepth({ limit: 7 }).maxPages).toBe(DEPTH_PROFILES.standard.maxPages)
  })
})

describe("captureToGoal", () => {
  it("stops early once maxRecords is met (via abort)", async () => {
    const r = await captureToGoal(fakeAdapter(100, 100), "roman", {
      slices: ["authored", "connections"],
      goal: { maxRecords: 10 },
    })
    expect(r.metGoal).toBe(true)
    expect(r.tally.total).toBe(10)
    expect(r.records.length).toBe(10)
  })

  it("stops once every per-slice target is met", async () => {
    const r = await captureToGoal(fakeAdapter(100, 100), "roman", {
      slices: ["authored", "connections"],
      goal: { perSlice: { authored: 5, connections: 3 } },
    })
    expect(r.metGoal).toBe(true)
    expect(r.tally.bySlice.authored).toBeGreaterThanOrEqual(5)
    expect(r.tally.bySlice.connections).toBeGreaterThanOrEqual(3)
  })

  it("runs dry (metGoal false) when the adapter yields less than the goal", async () => {
    const r = await captureToGoal(fakeAdapter(2, 2), "roman", {
      slices: ["authored", "connections"],
      goal: { maxRecords: 1000 },
    })
    expect(r.metGoal).toBe(false)
    expect(r.tally.total).toBe(5) // profile + 2 posts + 2 connections
    expect(r.profile?.handle).toBe("roman")
  })

  it("supports a custom stopWhen predicate", async () => {
    const r = await captureToGoal(fakeAdapter(100, 0), "roman", {
      slices: ["authored"],
      goal: { stopWhen: (t) => t.byKind.post >= 4 },
    })
    expect(r.tally.byKind.post).toBe(4)
  })
})
