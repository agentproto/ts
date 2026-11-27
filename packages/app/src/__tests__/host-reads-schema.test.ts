import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { boundariesError } from "../boundaries.js"
import { parseServiceList } from "../manifest-fields.js"

const schemaPath = fileURLToPath(
  new URL("../../../../specs/resources/aip-53/draft/APP.schema.json", import.meta.url),
)
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
  properties: { boundaries: { properties: { hostReads: { items: { pattern: string } } } } }
}
// JSON Schema `pattern` is an unanchored ECMA-262 regex, same as RegExp#test.
const pattern = new RegExp(schema.properties.boundaries.properties.hostReads.items.pattern)

const VALID = ["packages/foo", ".claude-like/x", "a", "./packages/foo", "a/b/", "..foo", "foo..", "a/..b/c", ".hidden", "dir with space/x"]
const INVALID = [".", "./", ".//", ".///", "/abs", "/", "..", "../x", "a/../b", "a/..", "./..", "", " ", " a", "a ", "a\t", "\ta"]

describe("APP.schema.json boundaries.hostReads item pattern", () => {
  it.each(VALID)("accepts %j", p => {
    expect(pattern.test(p)).toBe(true)
  })
  it.each(INVALID)("refuses %j", p => {
    expect(pattern.test(p)).toBe(false)
  })
  it.each([...VALID, ...INVALID])("agrees with the loader on %j", p => {
    expect(pattern.test(p)).toBe(boundariesError({ hostReads: [p] }) === undefined)
  })
})

describe("APP.schema.json services[].cwd pattern", () => {
  const svc = JSON.parse(readFileSync(schemaPath, "utf8")) as {
    properties: Record<string, unknown>
  }
  const find = (o: unknown): string | undefined => {
    if (typeof o !== "object" || o === null) return undefined
    const r = o as Record<string, unknown>
    const cwd = (r.properties as Record<string, { pattern?: string }> | undefined)?.cwd
    if (cwd?.pattern) return cwd.pattern
    for (const v of Object.values(r)) {
      const f = find(v)
      if (f) return f
    }
    return undefined
  }
  const cwdPattern = new RegExp(find(svc.properties.services) ?? "")
  const loaderAccepts = (cwd: string) =>
    parseServiceList([{ name: "web", command: "node", cwd }]).errors.length === 0

  it.each([".", "./", "sub", "sub/dir", "./sub/dir", "a..b", "..a"])("accepts %j", cwd => {
    expect(cwdPattern.test(cwd)).toBe(true)
    expect(loaderAccepts(cwd)).toBe(true)
  })
  it.each(["/abs", "..", "../x", "a/../b", "a/.."])("refuses %j", cwd => {
    expect(cwdPattern.test(cwd)).toBe(false)
    expect(loaderAccepts(cwd)).toBe(false)
  })
})
