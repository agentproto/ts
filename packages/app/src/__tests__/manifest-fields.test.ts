/**
 * Unit coverage for `parseServiceList` — the non-throwing wrapper around
 * `serviceList` that runtime's `parseAppServices` now delegates to.
 * `normalizeManifestFields`'s own (throw-based) `services` behavior is
 * covered via `defineApp`/`loadAppHandle` in define-app.test.ts /
 * load-app.test.ts and is unchanged by this wrapper.
 */

import { describe, it, expect } from "vitest"
import { parseServiceList } from "../manifest-fields.js"

describe("parseServiceList", () => {
  it("undefined and null are both the no-op case", () => {
    expect(parseServiceList(undefined)).toEqual({ services: [], errors: [] })
    expect(parseServiceList(null)).toEqual({ services: [], errors: [] })
  })

  it("parses name/entry/port entries", () => {
    expect(
      parseServiceList([
        { name: "web", entry: "node server.js", port: 4321 },
        { name: "worker", entry: "node worker.js" },
      ]),
    ).toEqual({
      services: [
        { name: "web", entry: "node server.js", port: 4321 },
        { name: "worker", entry: "node worker.js" },
      ],
      errors: [],
    })
  })

  it("rejects a non-array block", () => {
    const { services, errors } = parseServiceList({ name: "web" })
    expect(services).toEqual([])
    expect(errors).toHaveLength(1)
  })

  it("rejects an explicitly-present but empty array", () => {
    const { services, errors } = parseServiceList([])
    expect(services).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("at least one service")
  })

  it("rejects a name starting with a digit", () => {
    const { errors } = parseServiceList([{ name: "0abc", entry: "x" }])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("kebab-case slug")
  })

  it("accepts a name with consecutive/trailing hyphens", () => {
    const { services, errors } = parseServiceList([{ name: "a--b", entry: "x" }])
    expect(errors).toEqual([])
    expect(services).toEqual([{ name: "a--b", entry: "x" }])
  })

  it("rejects an unknown object field", () => {
    const { errors } = parseServiceList([{ name: "web", entry: "x", extra: 1 }])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("not a supported service field")
  })

  it("rejects duplicate names", () => {
    const { errors } = parseServiceList([
      { name: "web", entry: "a" },
      { name: "web", entry: "b" },
    ])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("unique")
  })

  it("rejects a bad port (zero, too high, or non-integer)", () => {
    expect(parseServiceList([{ name: "api", entry: "a", port: 0 }]).errors[0]).toContain(
      "integer between 1 and 65535",
    )
    expect(parseServiceList([{ name: "api", entry: "a", port: 70000 }]).errors[0]).toContain(
      "integer between 1 and 65535",
    )
    expect(parseServiceList([{ name: "api", entry: "a", port: 1.5 }]).errors[0]).toContain(
      "integer between 1 and 65535",
    )
  })

  it("fails fast on the first bad entry — a single-element errors array", () => {
    const { errors } = parseServiceList([
      { name: "Bad", entry: "x" },
      { name: "also-bad", entry: "" },
    ])
    expect(errors).toHaveLength(1)
  })

  it("accepts a custom key name in the error message", () => {
    const { errors } = parseServiceList([], "frontmatter.services")
    expect(errors[0]).toContain("'frontmatter.services'")
  })

  describe("cwd (AIP-53: relative to the app dir, no `..` segment)", () => {
    const cwdErrors = (cwd: string) =>
      parseServiceList([{ name: "web", command: "node", cwd }], "services").errors

    it.each(["/etc", "/", "/abs/server"])("rejects the absolute cwd %j", cwd => {
      const errors = cwdErrors(cwd)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain("'services[0].cwd'")
      expect(errors[0]).toContain("service 'web'")
      expect(errors[0]).toContain("absolute")
    })

    it.each(["..", "../x", "a/..", "a/../b", "a/b/../../c", "./../x"])(
      "rejects the cwd %j containing a `..` segment",
      cwd => {
        const errors = cwdErrors(cwd)
        expect(errors).toHaveLength(1)
        expect(errors[0]).toContain("'services[0].cwd'")
        expect(errors[0]).toContain("service 'web'")
        expect(errors[0]).toContain("..")
      },
    )

    it.each([".", "./", "sub", "sub/dir", "./sub/dir", "a..b", "..a", "a/..b", "a/b..", "a/.../b"])(
      "accepts the cwd %j",
      cwd => {
        const { services, errors } = parseServiceList([{ name: "web", command: "node", cwd }])
        expect(errors).toEqual([])
        expect(services).toEqual([{ name: "web", command: "node", cwd }])
      },
    )

    it("applies the same rule to the legacy `entry` form", () => {
      expect(parseServiceList([{ name: "web", entry: "x", cwd: "/abs" }]).errors).toHaveLength(1)
      expect(parseServiceList([{ name: "web", entry: "x", cwd: "a/../b" }]).errors).toHaveLength(1)
      expect(parseServiceList([{ name: "web", entry: "x", cwd: "sub/dir" }]).errors).toEqual([])
    })
  })
})
