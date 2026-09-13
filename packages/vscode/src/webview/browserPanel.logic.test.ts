import { describe, expect, it } from "vitest"

import { frameMessage, nextPollDelayMs } from "./browserPanel.logic.js"

describe("frameMessage", () => {
  it("builds a data URL from format + base64 data", () => {
    const msg = frameMessage({ data: "AAAA", format: "png" }, 1000)
    expect(msg).toEqual({ type: "frame", dataUrl: "data:image/png;base64,AAAA", at: 1000 })
  })

  it("carries width/height through when present", () => {
    const msg = frameMessage({ data: "AAAA", format: "jpeg", width: 1280, height: 720 }, 2000)
    expect(msg).toEqual({
      type: "frame",
      dataUrl: "data:image/jpeg;base64,AAAA",
      width: 1280,
      height: 720,
      at: 2000,
    })
  })

  it("omits width/height when absent", () => {
    const msg = frameMessage({ data: "AAAA", format: "png" }, 1000)
    expect(msg).not.toHaveProperty("width")
    expect(msg).not.toHaveProperty("height")
  })
})

describe("nextPollDelayMs", () => {
  it("polls every 2s with no failures", () => {
    expect(nextPollDelayMs(0)).toBe(2000)
    expect(nextPollDelayMs(1)).toBe(2000)
    expect(nextPollDelayMs(2)).toBe(2000)
  })

  it("backs off to 5s at 3 consecutive failures", () => {
    expect(nextPollDelayMs(3)).toBe(5000)
    expect(nextPollDelayMs(10)).toBe(5000)
  })
})
