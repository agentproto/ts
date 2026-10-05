import { describe, it, expect } from "vitest"
import { versionSatisfies, parseVersionRange } from "../version-range.js"
import { normalizeManifestFields } from "../manifest-fields.js"

const declared = { agents: [], workflows: ["w"] }
const fail = (msg: string) => new Error(msg)

describe("versionSatisfies", () => {
  it("matches an exact version only", () => {
    expect(versionSatisfies("1.2.3", "1.2.3")).toBe(true)
    expect(versionSatisfies("1.2.4", "1.2.3")).toBe(false)
  })

  it("caret pins the major and requires >= the stated version", () => {
    expect(versionSatisfies("1.4.0", "^1.2")).toBe(true)
    expect(versionSatisfies("1.1.9", "^1.2")).toBe(false)
    expect(versionSatisfies("2.0.0", "^1.2")).toBe(false)
    expect(versionSatisfies("1.0.0", "^1")).toBe(true)
  })

  it("tilde pins the minor when given, else only the major", () => {
    expect(versionSatisfies("1.2.9", "~1.2.3")).toBe(true)
    expect(versionSatisfies("1.3.0", "~1.2.3")).toBe(false)
    expect(versionSatisfies("1.9.0", "~1")).toBe(true)
    expect(versionSatisfies("2.0.0", "~1")).toBe(false)
  })

  it("ignores a prerelease suffix", () => {
    expect(versionSatisfies("1.2.3-rc1", "^1")).toBe(true)
  })

  it("rejects ranges outside the supported shapes", () => {
    expect(() => parseVersionRange(">=1.0.0")).toThrow(/invalid version range/)
    expect(() => parseVersionRange("*")).toThrow(/invalid version range/)
  })
})

describe("requires.apps entries", () => {
  it("normalizes bare ids and object entries side by side", () => {
    const out = normalizeManifestFields(
      { requires: { apps: ["@x/plain", { id: "@x/rich", version: "^1.2", workflows: ["w"] }] } },
      declared,
      fail,
    )
    expect(out.requires).toEqual(["@x/plain", "@x/rich"])
    expect(out.appRequirements).toEqual([
      { id: "@x/plain" },
      { id: "@x/rich", version: "^1.2", workflows: ["w"] },
    ])
  })

  it("keeps the legacy flat array working", () => {
    const out = normalizeManifestFields({ requires: ["@x/a", "@x/b"] }, declared, fail)
    expect(out.requires).toEqual(["@x/a", "@x/b"])
    expect(out.appRequirements).toEqual([{ id: "@x/a" }, { id: "@x/b" }])
  })

  it("rejects an unparseable version range with a field-prefixed message", () => {
    expect(() =>
      normalizeManifestFields({ requires: { apps: [{ id: "@x/a", version: ">=1" }] } }, declared, fail),
    ).toThrow(/requires\.apps\[0\]\.version/)
  })

  it("rejects unknown entry fields and non-string workflows", () => {
    expect(() =>
      normalizeManifestFields({ requires: { apps: [{ id: "@x/a", nope: 1 }] } }, declared, fail),
    ).toThrow(/not a supported requires\.apps entry field/)
    expect(() =>
      normalizeManifestFields({ requires: { apps: [{ id: "@x/a", workflows: [1] }] } }, declared, fail),
    ).toThrow(/workflows/)
  })
})
