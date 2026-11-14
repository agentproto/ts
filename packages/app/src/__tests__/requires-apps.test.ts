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

  it("caret on 0.x follows npm: it pins the minor, or the patch for 0.0.x", () => {
    expect(versionSatisfies("0.2.9", "^0.2.3")).toBe(true)
    expect(versionSatisfies("0.3.0", "^0.2.3")).toBe(false)
    expect(versionSatisfies("0.0.3", "^0.0.3")).toBe(true)
    expect(versionSatisfies("0.0.4", "^0.0.3")).toBe(false)
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

  it("takes tools as the provider's MCP names and round-trips them", () => {
    const out = normalizeManifestFields(
      { requires: { apps: [{ id: "@agentik/bureau", version: "^0.3", tools: ["bureau_navigate", "bureau_list_instances"] }] } },
      declared,
      fail,
    )
    expect(out.appRequirements).toEqual([
      { id: "@agentik/bureau", version: "^0.3", tools: ["bureau_navigate", "bureau_list_instances"] },
    ])
  })

  it("refuses a tools entry that is not an MCP name, an exposes.tools id included, naming its index", () => {
    const tools = (list: unknown[]) => () =>
      normalizeManifestFields({ requires: { apps: [{ id: "@agentik/bureau", tools: list }] } }, declared, fail)
    expect(tools(["bureau_navigate", "imported:bureau/browser_navigate"])).toThrow(/requires\.apps\[0\]\.tools\[1\]/)
    expect(tools(["bureau.status"])).toThrow(/MCP name/)
    expect(tools(["Bureau_x"])).toThrow(/MCP name/)
    expect(tools(["bureau_"])).toThrow(/MCP name/)
    expect(tools([`bureau_${"a".repeat(60)}`])).toThrow(/64/)
    expect(tools(["bureau_a", "bureau_a"])).toThrow(/duplicate/)
    expect(tools("bureau_a" as never)).toThrow(/array/)
  })

  it("refuses two apps entries naming the same id, and an unknown requires key", () => {
    expect(() =>
      normalizeManifestFields({ requires: { apps: ["@x/a", { id: "@x/a", version: "^1" }] } }, declared, fail),
    ).toThrow(/requires\.apps\[1\]': duplicate app id/)
    expect(() => normalizeManifestFields({ requires: { apps: [], network: true } }, declared, fail)).toThrow(
      /'requires\.network' is not a supported requires field/,
    )
  })
})
