import { describe, expect, it } from "vitest"

import { buildAuthHeaders } from "./auth.js"

describe("buildAuthHeaders", () => {
  it("returns authHeaders verbatim when they are configured", () => {
    const headers = { Cookie: "_port_auth=box-token" }
    expect(buildAuthHeaders(headers, "bearer-token")).toEqual(headers)
  })

  it("falls back to a Bearer token when authHeaders are absent", () => {
    expect(buildAuthHeaders(undefined, "bearer-token")).toEqual({
      authorization: "Bearer bearer-token",
    })
  })

  it("falls back to a Bearer token when authHeaders are an empty object", () => {
    // An empty object is treated as "not configured" so the bearer fallback
    // still works, matching the default `agentproto.authHeaders: {}` setting.
    expect(buildAuthHeaders({}, "bearer-token")).toEqual({
      authorization: "Bearer bearer-token",
    })
  })

  it("returns an empty object when neither authHeaders nor a token is set", () => {
    expect(buildAuthHeaders(undefined, undefined)).toEqual({})
  })

  it("returns an empty object when authHeaders are empty and there is no token", () => {
    expect(buildAuthHeaders({}, undefined)).toEqual({})
  })
})
