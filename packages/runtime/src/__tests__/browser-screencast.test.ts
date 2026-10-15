/**
 * Tests for browser-screencast.ts's pure helpers — in particular the mp4
 * concat list's show-time rule (the reviewer-caught off-by-one: each frame's
 * `duration` is the gap to the NEXT frame, not the one behind it).
 */

import { describe, expect, it } from "vitest"
import { buildScreencastConcatList, type ScreencastFrameLike } from "../browser-screencast.js"

const frame = (data: string, timestampMs: number): ScreencastFrameLike => ({
  data,
  format: "jpeg",
  timestampMs,
  index: 0,
})

describe("buildScreencastConcatList", () => {
  it("uses the gap to the NEXT frame as each frame's show time", () => {
    const list = buildScreencastConcatList([
      frame("A", 1_000),
      frame("B", 1_500), // A shows for 0.5s → B
      frame("C", 1_750), // B shows for 0.25s → C
    ])
    // files in capture order:
    expect(list.filter(l => l.startsWith("file"))).toEqual([
      "file 'f0000.jpg'",
      "file 'f0001.jpg'",
      "file 'f0002.jpg'",
      // concat-demuxer rule: the last file named again, duration ignored.
      "file 'f0002.jpg'",
    ])
    const durations = list.filter(l => l.startsWith("duration"))
    expect(durations).toEqual(["duration 0.5", "duration 0.25", "duration 0.25"])
  })

  it("clamps show times into [0.05, 2] seconds and pads a lone last frame", () => {
    const list = buildScreencastConcatList([
      frame("A", 0),
      frame("B", 5_000), // A shows for a 5s gap → clamped to 2
      frame("C", 3_500), // B's next ts went backwards → clamped to the 0.05 floor
    ])
    const durations = list.filter(l => l.startsWith("duration"))
    expect(durations).toEqual(["duration 2", "duration 0.05", "duration 0.25"])
  })

  it("follows the first frame's encoding for file extensions", () => {
    const list = buildScreencastConcatList([
      { data: "A", format: "png", timestampMs: 0, index: 0 },
      { data: "B", format: "png", timestampMs: 100, index: 1 },
    ])
    expect(list.filter(l => l.startsWith("file")).every(l => l.endsWith(".png'"))).toBe(true)
  })
})
