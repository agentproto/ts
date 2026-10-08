import { describe, it, expect } from "vitest"
import { parseMcpAppHttpArgs, validateTenants } from "../commands/mcp-app-http.js"

describe("parseMcpAppHttpArgs", () => {
  it("parses dir, port, host and tenants", () => {
    expect(
      parseMcpAppHttpArgs(["./app", "--port", "8080", "--host", "0.0.0.0", "--tenants", "t.json"]),
    ).toEqual({ dir: "./app", port: 8080, host: "0.0.0.0", tenantsPath: "t.json" })
  })

  it("accepts the dir after the flags", () => {
    expect(parseMcpAppHttpArgs(["--port", "1", "./app"])).toEqual({ dir: "./app", port: 1 })
  })

  it.each(["0", "65536", "abc", "80.5", "-1", "1e3"])("rejects --port %s", (port) => {
    expect(() => parseMcpAppHttpArgs(["./app", "--port", port])).toThrow(/--port must be an integer/)
  })

  it("rejects a flag with no value (end of argv or followed by another flag)", () => {
    expect(() => parseMcpAppHttpArgs(["./app", "--port"])).toThrow(/--port requires a value/)
    expect(() => parseMcpAppHttpArgs(["./app", "--host", "--port", "80"])).toThrow(/--host requires a value/)
  })

  it("rejects unknown flags, extra positionals and a missing dir", () => {
    expect(() => parseMcpAppHttpArgs(["./app", "--bogus"])).toThrow(/unknown flag/)
    expect(() => parseMcpAppHttpArgs(["./a", "./b"])).toThrow(/unexpected extra argument/)
    expect(() => parseMcpAppHttpArgs(["--port", "80"])).toThrow(/missing <appDir>/)
  })
})

describe("validateTenants", () => {
  it("accepts declared secrets and warns about missing ones", () => {
    const { tenants, warnings } = validateTenants({ "shop-a": { API_KEY: "k" }, "shop-b": {} }, ["API_KEY"])
    expect(tenants).toEqual({ "shop-a": { API_KEY: "k" }, "shop-b": {} })
    expect(warnings).toEqual(["tenant 'shop-b': declared secret 'API_KEY' is not set"])
  })

  it("rejects a secret the app does not declare", () => {
    expect(() => validateTenants({ a: { TYPO: "x" } }, ["API_KEY"])).toThrow(/not declared in the app's requirements\.secrets/)
  })

  it("rejects wrong shapes and unroutable slugs", () => {
    expect(() => validateTenants([], [])).toThrow(/JSON object/)
    expect(() => validateTenants(null, [])).toThrow(/JSON object/)
    expect(() => validateTenants({ a: "nope" }, [])).toThrow(/must be an object/)
    expect(() => validateTenants({ a: { K: 1 } }, ["K"])).toThrow(/must be a string/)
    expect(() => validateTenants({ "Bad Slug": {} }, [])).toThrow(/invalid/)
  })
})
