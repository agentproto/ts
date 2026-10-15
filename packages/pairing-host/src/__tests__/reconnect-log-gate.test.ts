import { describe, expect, test } from "vitest"

import { createReconnectLogGate } from "../reconnect-log-gate.js"

describe("createReconnectLogGate", () => {
  test("logs the first event, suppresses repeats within the window, then summarizes", () => {
    let now = 0
    const gate = createReconnectLogGate({ windowMs: 1_000, now: () => now })

    expect(gate.onFailure("k", "boom")).toBe("boom")
    now += 100
    expect(gate.onFailure("k", "boom")).toBeNull()
    now += 100
    expect(gate.onFailure("k", "boom")).toBeNull()
    now += 1_000 // past the window → emit with the suppressed count
    expect(gate.onFailure("k", "boom")).toBe("boom (2 failures suppressed)")
  })

  test("a successful connect resets suppression so the next event logs at once", () => {
    let now = 0
    const gate = createReconnectLogGate({ windowMs: 1_000, now: () => now })
    expect(gate.onFailure("k", "boom")).toBe("boom")
    now += 100
    expect(gate.onFailure("k", "boom")).toBeNull()
    gate.onSuccess("k")
    expect(gate.onFailure("k", "boom")).toBe("boom")
  })

  test("the custom noun names the suppressed repeats (channel flaps, not failures)", () => {
    let now = 0
    const gate = createReconnectLogGate({ windowMs: 1_000, now: () => now, noun: "flap" })
    expect(gate.onFailure("k", "up")).toBe("up")
    now += 100
    expect(gate.onFailure("k", "up")).toBeNull()
    now += 100
    expect(gate.onFailure("k", "up")).toBeNull()
    now += 1_000
    expect(gate.onFailure("k", "up")).toBe("up (2 flaps suppressed)")
  })
})
