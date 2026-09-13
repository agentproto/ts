import { describe, it, expect } from "vitest"

import {
  computeAddedAtLedger,
  isoDateFromUnixSeconds,
  serializeLedger,
} from "../added-at.js"

describe("computeAddedAtLedger", () => {
  it("stamps a brand-new id with the source's created timestamp when available", () => {
    const ledger = computeAddedAtLedger(
      ["vendor/new-model"],
      {},
      { "vendor/new-model": "2026-01-15" },
      "2026-08-31"
    )
    expect(ledger["vendor/new-model"]).toBe("2026-01-15")
  })

  it("stamps a brand-new id with today when the source has no created timestamp", () => {
    const ledger = computeAddedAtLedger(["vendor/new-model"], {}, {}, "2026-08-31")
    expect(ledger["vendor/new-model"]).toBe("2026-08-31")
  })

  it("NEVER mutates an existing id's stamp, even if createdAt now resolves differently", () => {
    const previous = { "vendor/existing": "2026-01-01" }
    const ledger = computeAddedAtLedger(
      ["vendor/existing"],
      previous,
      { "vendor/existing": "2026-08-30" }, // source now claims a different creation date
      "2026-08-31"
    )
    expect(ledger["vendor/existing"]).toBe("2026-01-01")
  })

  it("second run with an unchanged source doesn't touch any existing stamp", () => {
    const previous = { "vendor/a": "2026-01-01", "vendor/b": "2026-02-02" }
    const ledger = computeAddedAtLedger(
      ["vendor/a", "vendor/b"],
      previous,
      {},
      "2026-08-31"
    )
    expect(ledger).toEqual(previous)
  })

  it("keeps an id's stamp even after it disappears from the current run (first-ever-seen, not currently-present)", () => {
    const previous = { "vendor/gone": "2025-06-01" }
    const ledger = computeAddedAtLedger([], previous, {}, "2026-08-31")
    expect(ledger["vendor/gone"]).toBe("2025-06-01")
  })

  it("a reappearing id keeps its original stamp rather than being re-stamped", () => {
    const previous = { "vendor/back-again": "2025-06-01" }
    const ledger = computeAddedAtLedger(
      ["vendor/back-again"],
      previous,
      { "vendor/back-again": "2026-08-31" },
      "2026-08-31"
    )
    expect(ledger["vendor/back-again"]).toBe("2025-06-01")
  })

  it("mixes untouched existing ids with freshly stamped new ones in the same run", () => {
    const previous = { "vendor/existing": "2026-01-01" }
    const ledger = computeAddedAtLedger(
      ["vendor/existing", "vendor/fresh"],
      previous,
      { "vendor/fresh": "2026-08-20" },
      "2026-08-31"
    )
    expect(ledger).toEqual({
      "vendor/existing": "2026-01-01",
      "vendor/fresh": "2026-08-20",
    })
  })
})

describe("isoDateFromUnixSeconds", () => {
  it("converts Unix seconds to a YYYY-MM-DD date", () => {
    // 1787752741 → 2026-08-26 (the z-ai/glm-5.3-flash `created` value from the live payload).
    expect(isoDateFromUnixSeconds(1787752741)).toBe("2026-08-26")
  })
})

describe("serializeLedger", () => {
  it("sorts keys and ends with a trailing newline", () => {
    const out = serializeLedger({ b: "2026-01-02", a: "2026-01-01" })
    expect(out).toBe('{\n  "a": "2026-01-01",\n  "b": "2026-01-02"\n}\n')
  })

  it("round-trips through JSON.parse", () => {
    const ledger = { "vendor/a": "2026-01-01", "vendor/b": "2026-02-02" }
    expect(JSON.parse(serializeLedger(ledger))).toEqual(ledger)
  })
})
