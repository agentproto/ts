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

  it("ignores unknown keys and returns only the known fields", () => {
    const result = parseReachReceipt({ status: "delivered", messageId: "x" })
    expect(result).toEqual({ ok: true, receipt: { status: "delivered" } })
    expect(result.ok && result.receipt).not.toHaveProperty("messageId")
    expect(parseReachReceipt('{"status":"deferred","until":"2026-11-13T08:00:00Z","traceId":"t1"}')).toEqual({
      ok: true,
      receipt: { status: "deferred", until: "2026-11-13T08:00:00Z" },
    })
    expect(parseReachReceipt({ status: "failed", reason: "x", messageId: 7 })).toEqual({
      ok: true,
      receipt: { status: "failed", reason: "x" },
    })
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
    ["a bad at", { status: "delivered", at: "now" }],
    ["a non-string adapterId", { status: "delivered", adapterId: 3 }],
    ["deduped with an until", { status: "deduped", until: "2026-11-13T08:00:00Z" }],
    ["a bare ok with an extra key", { ok: true, messageId: "x" }],
  ])("refuses %s", (_name, body) => {
    expect(parseReachReceipt(body).ok).toBe(false)
  })
})
