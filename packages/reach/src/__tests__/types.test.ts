import { describe, expect, it } from "vitest"

import { isAcknowledged, type ReachRouteEntry } from "../types.js"

describe("isAcknowledged", () => {
  it("is true for delivered, deferred and deduped only", () => {
    expect(isAcknowledged({ status: "delivered" })).toBe(true)
    expect(isAcknowledged({ status: "deferred" })).toBe(true)
    expect(isAcknowledged({ status: "deduped" })).toBe(true)
    expect(isAcknowledged({ status: "undelivered" })).toBe(false)
    expect(isAcknowledged({ status: "failed" })).toBe(false)
  })

  it("narrows a route entry by kind", () => {
    const label = (entry: ReachRouteEntry): string => (entry.kind === "webhook" ? entry.url : (entry.alias ?? "default"))
    expect(label({ id: "floor", kind: "telegram" })).toBe("default")
    expect(label({ id: "p", kind: "webhook", url: "https://r.invalid/", secret: "whsec_x" })).toBe("https://r.invalid/")
  })
})
