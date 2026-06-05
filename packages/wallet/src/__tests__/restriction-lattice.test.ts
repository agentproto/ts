import { describe, it, expect } from "vitest"
import {
  UNRESTRICTED,
  canonical,
  meet,
  lessRestrictedOrEqual,
  equalRestriction,
  verifyLattice,
} from "../restriction-lattice.js"

describe("restriction lattice", () => {
  it("canonical sorts + dedupes + drops empties", () => {
    expect(canonical(["b", "a", "b", ""])).toEqual(["a", "b"])
  })

  it("meet is the union — restrictions accumulate", () => {
    expect(meet(["image-only"], ["promo"])).toEqual(["image-only", "promo"])
    expect(meet(["a"], [])).toEqual(["a"])
  })

  it("meet is idempotent, commutative, associative", () => {
    const a = canonical(["x"])
    const b = canonical(["y"])
    const c = canonical(["z"])
    expect(meet(a, a)).toEqual(a)
    expect(meet(a, b)).toEqual(meet(b, a))
    expect(meet(meet(a, b), c)).toEqual(meet(a, meet(b, c)))
  })

  it("meet only ADDS restriction — laundering is structurally impossible", () => {
    const restricted = canonical(["non-withdrawable"])
    const out = meet(restricted, UNRESTRICTED)
    // converting can never drop a tag
    expect(lessRestrictedOrEqual(restricted, out)).toBe(true)
    expect(equalRestriction(out, UNRESTRICTED)).toBe(false)
  })

  it("verifyLattice passes the semilattice axioms over a sample", () => {
    const sample = [
      UNRESTRICTED,
      canonical(["image-only"]),
      canonical(["promo"]),
      canonical(["image-only", "promo"]),
      canonical(["non-withdrawable"]),
    ]
    const res = verifyLattice(sample)
    expect(res.ok).toBe(true)
    expect(res.violations).toEqual([])
  })
})
