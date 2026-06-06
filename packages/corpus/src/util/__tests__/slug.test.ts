import { describe, it, expect } from "vitest"
import {
  slugify,
  uniqueSlug,
  isSourceSlug,
  isEntrySlug,
} from "../slug.js"

describe("slugify", () => {
  it("lowercases, strips accents, collapses to dashes", () => {
    expect(slugify("Réduire l'Ambiguïté  des  Décisions")).toBe(
      "reduire-l-ambiguite-des-decisions"
    )
  })

  it("source style allows a leading digit", () => {
    expect(slugify("4 Ps of Marketing")).toBe("4-ps-of-marketing")
    expect(isSourceSlug(slugify("4 Ps of Marketing"))).toBe(true)
  })

  it("entry style (leadingLetter) prefixes a digit-leading slug → valid entry id", () => {
    const s = slugify("10x Your Conversions", { leadingLetter: true })
    expect(s).toBe("e-10x-your-conversions")
    expect(isEntrySlug(s)).toBe(true)
  })

  it("entry style fixes the schema-invalid cases that used to reach disk", () => {
    for (const title of ["2026 plan", "3 Ways to Win", "404s explained"]) {
      const s = slugify(title, { leadingLetter: true, fallback: "entry" })
      expect(isEntrySlug(s)).toBe(true) // would have failed ^[a-z]… before
    }
  })

  it("falls back when the result is empty or degenerate", () => {
    expect(slugify("!!!", { fallback: "entry" })).toBe("entry")
    expect(slugify("A", { fallback: "entry" })).toBe("entry") // length 1 → fallback
    expect(slugify("", { fallback: "source" })).toBe("source")
  })

  it("stripScheme removes a leading protocol for URL slugs", () => {
    expect(slugify("https://blog.example.com/post", { stripScheme: true })).toBe(
      "blog-example-com-post"
    )
  })

  it("never leaves a trailing dash even when the cut lands mid-dash", () => {
    const s = slugify("a".repeat(79) + " tail", { maxLen: 80 })
    expect(s.endsWith("-")).toBe(false)
  })
})

describe("uniqueSlug", () => {
  it("disambiguates collisions with a numeric suffix (stays entry-valid)", () => {
    const seen = new Set<string>()
    expect(uniqueSlug("intro", seen)).toBe("intro")
    expect(uniqueSlug("intro", seen)).toBe("intro-2")
    expect(uniqueSlug("intro", seen)).toBe("intro-3")
    expect(isEntrySlug("intro-2")).toBe(true)
  })
})

describe("slug validators", () => {
  it("isSourceSlug allows leading digit, isEntrySlug requires a leading letter", () => {
    expect(isSourceSlug("4-ps")).toBe(true)
    expect(isEntrySlug("4-ps")).toBe(false)
    expect(isEntrySlug("ps-4")).toBe(true)
    expect(isSourceSlug("a")).toBe(false) // length < 2
  })
})
