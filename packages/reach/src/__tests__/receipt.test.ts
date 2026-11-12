import { describe, expect, it } from "vitest"

import { parseReachReceipt } from "../receipt.js"

describe("parseReachReceipt", () => {
  it("accepts each valid receipt, as an object or as JSON text", () => {
    expect(parseReachReceipt({ status: "delivered" })).toEqual({ ok: true, receipt: { status: "delivered" } })
    expect(parseReachReceipt('{"status":"deduped"}')).toEqual({ ok: true, receipt: { status: "deduped" } })
    expect(parseReachReceipt({ status: "deferred", until: "2026-11-13T08:00:00Z" })).toEqual({
      ok: true,
      receipt: { status: "deferred", until: "2026-11-13T08:00:00Z" },
    })
    expect(parseReachReceipt({ status: "undelivered", reason: "no-binding" })).toEqual({
      ok: true,
      receipt: { status: "undelivered", reason: "no-binding" },
    })
    expect(parseReachReceipt({ status: "failed", reason: "x", adapterId: "p", at: "2026-11-12T10:00:00Z" }).ok).toBe(true)
  })

  it.each([
    ["an empty body", ""],
    ["a bare ok", { ok: true }],
    ["not JSON", "OK"],
    ["an array", [{ status: "delivered" }]],
    ["null", null],
    ["an unknown status", { status: "sent" }],
    ["deferred without until", { status: "deferred" }],
    ["deferred with a bad until", { status: "deferred", until: "tomorrow" }],
    ["undelivered without reason", { status: "undelivered" }],
    ["failed with an empty reason", { status: "failed", reason: " " }],
    ["delivered with a reason", { status: "delivered", reason: "x" }],
    ["an unknown key", { status: "delivered", extra: 1 }],
    ["a bad at", { status: "delivered", at: "now" }],
  ])("refuses %s", (_name, body) => {
    expect(parseReachReceipt(body).ok).toBe(false)
  })
})
