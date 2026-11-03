/**
 * The mp4 concat list's show-time rule: each frame's `duration` is the gap
 * to the NEXT frame, not the one behind it (which shifted every frame's show
 * time one frame late and gave the first frame the 0.05s floor).
 */

import { describe, expect, it } from "vitest"
import { buildScreencastConcatList, type ScreencastFrameLike } from "../browser-screencast.js"

const frame = (timestampMs: number, format: "jpeg" | "png" = "jpeg"): ScreencastFrameLike => ({
  data: "AA==",
  format,
  timestampMs,
  index: 0,
})

const durations = (list: string[]) => list.filter(line => line.startsWith("duration"))
const files = (list: string[]) => list.filter(line => line.startsWith("file"))

describe("buildScreencastConcatList", () => {
  it("shows each frame for the gap to the next frame", () => {
    const list = buildScreencastConcatList([frame(1_000), frame(1_500), frame(1_750)])
    expect(durations(list)).toEqual(["duration 0.5", "duration 0.25", "duration 0.25"])
    expect(files(list)).toEqual([
      "file 'f0000.jpg'",
      "file 'f0001.jpg'",
      "file 'f0002.jpg'",
      "file 'f0002.jpg'",
    ])
  })

  it("clamps show times into [0.05, 2] seconds", () => {
    const list = buildScreencastConcatList([frame(0), frame(5_000), frame(4_000)])
    expect(durations(list)).toEqual(["duration 2", "duration 0.05", "duration 0.25"])
  })

  it("names png frames with a .png extension", () => {
    const list = buildScreencastConcatList([frame(0, "png"), frame(100, "png")])
    expect(files(list).every(line => line.endsWith(".png'"))).toBe(true)
  })
})
