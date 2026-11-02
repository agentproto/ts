import { describe, expect, it } from "vitest"

import { computeLevel, levelToTier, type Envelope, type Level } from "../index.js"

function env(over: Partial<Envelope> = {}): Envelope {
  return {
    specversion: "1.0",
    id: "evt_1",
    source: "agentproto:test",
    type: "acme.widget.failed",
    subject: "acme:widget/1",
    subjects: ["acme:widget/1"],
    time: "2026-11-01T00:00:00.000Z",
    summary: "x",
    data: {},
    terminal: false,
    ...over,
  }
}

describe("levelToTier", () => {
  it("maps 3 to steer, 2 to next-turn, 1 to fyi, 0 to drop", () => {
    expect(levelToTier(3)).toBe("steer")
    expect(levelToTier(2)).toBe("next-turn")
    expect(levelToTier(1)).toBe("fyi")
    expect(levelToTier(0)).toBe("drop")
  })
})

describe("computeLevel", () => {
  it("floor crash with a classifier returning 0 yields 3", () => {
    expect(computeLevel(env({ floor: "crash" }), 0, 3)).toBe(3)
  })

  it("floor is not lowered by the cap or the level hint", () => {
    expect(computeLevel(env({ floor: "awaiting-human", levelHint: 0 }), 1, 0)).toBe(3)
  })

  it("terminal never changes the level: a classifier returning 1 yields 1", () => {
    expect(computeLevel(env({ terminal: true }), 1, 3)).toBe(1)
    expect(computeLevel(env({ terminal: true }), undefined, 3)).toBe(2)
    expect(computeLevel(env({ terminal: true, levelHint: 0 }), undefined, 3)).toBe(0)
  })

  it("classifier result wins over the level hint", () => {
    expect(computeLevel(env({ levelHint: 3 }), 1, 3)).toBe(1)
    expect(computeLevel(env({ levelHint: 1 }), 0, 3)).toBe(0)
  })

  it("falls back to the level hint, then to 2", () => {
    expect(computeLevel(env({ levelHint: 1 }), undefined, 3)).toBe(1)
    expect(computeLevel(env(), undefined, 3)).toBe(2)
  })

  it("the subscription cap lowers a non-floor level", () => {
    const cases: [Level | undefined, Level, Level][] = [
      [3, 2, 2],
      [2, 1, 1],
      [2, 0, 0],
      [1, 3, 1],
    ]
    for (const [cls, cap, want] of cases) {
      expect(computeLevel(env(), cls, cap)).toBe(want)
    }
  })
})
