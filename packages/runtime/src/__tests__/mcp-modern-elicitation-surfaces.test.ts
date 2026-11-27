import { describe, it, expect } from "vitest"
import { buildApprovalUrl, checkApprovalUrl, coerceFormContent, type ElicitRequestedSchema } from "../mcp-modern/index.js"
import { resolveHumanGateSurfaces } from "../mcp-config.js"

describe("buildApprovalUrl", () => {
  it("adds only the approval id to the console URL", () => {
    expect(buildApprovalUrl("https://console.example.test/a?x=1", "apr_1")).toBe("https://console.example.test/a?x=1&approval=apr_1")
  })
  it.each([
    undefined,
    "not a url",
    "ftp://console.example.test/a",
    "https://user:pw@console.example.test/a",
    "https://console.example.test/a#frag",
    "https://console.example.test/a?access_token=1",
    "https://console.example.test/a?sig=1",
    // Guards: credential-like keys stay refused whatever their spelling.
    "https://console.example.test/a?token=x",
    "https://console.example.test/a?api_key=x",
    "https://console.example.test/a?session-id=x",
    "https://console.example.test/a?accessToken=x",
    "https://console.example.test/a?APIKey=x",
    "https://console.example.test/a?apikey=x",
    "https://console.example.test/a?password=x",
    "https://console.example.test/a?signature=x",
    "https://console.example.test/a?x.auth=x",
  ])("refuses %s", base => {
    expect(buildApprovalUrl(base, "apr_1")).toBeUndefined()
  })
  it.each(["designer", "insight", "mode"])("accepts a key that only contains a listed word inside it (%s)", key => {
    expect(buildApprovalUrl(`https://c.example.test/a?${key}=1`, "apr_1")).toBe(`https://c.example.test/a?${key}=1&approval=apr_1`)
  })
})

describe("checkApprovalUrl", () => {
  it("says why a base is refused, and never echoes the base", () => {
    expect(checkApprovalUrl(undefined, "apr_1")).toEqual({ ok: false, reason: "missing_base" })
    expect(checkApprovalUrl("not a url", "apr_1")).toEqual({ ok: false, reason: "invalid_url" })
    expect(checkApprovalUrl("ftp://c.example.test/a", "apr_1")).toEqual({ ok: false, reason: "unsupported_scheme" })
    expect(checkApprovalUrl("https://u:p@c.example.test/a", "apr_1")).toEqual({ ok: false, reason: "credential_in_url" })
    expect(checkApprovalUrl("https://c.example.test/a#t", "apr_1")).toEqual({ ok: false, reason: "credential_in_url" })
    expect(checkApprovalUrl("https://c.example.test/a?api_key=x", "apr_1")).toEqual({ ok: false, reason: "secret_query_key" })
  })
  it("returns the link for an accepted base", () => {
    expect(checkApprovalUrl("https://c.example.test/a?designer=1", "apr_1")).toEqual({
      ok: true,
      url: "https://c.example.test/a?designer=1&approval=apr_1",
    })
  })
})

describe("coerceFormContent", () => {
  const schema: ElicitRequestedSchema = {
    type: "object",
    properties: {
      pick: { type: "string", oneOf: [{ const: "a", title: "A" }, { const: "b", title: "B" }] },
      n: { type: "integer" },
      many: { type: "array", items: { type: "string", enum: ["x", "y"] } },
      ok: { type: "boolean" },
    },
    required: ["pick"],
  }
  it("keeps declared, well-typed values only", () => {
    expect(coerceFormContent(schema, { pick: "a", n: 2, many: ["x"], ok: true, extra: 1 })).toEqual({
      ok: true,
      value: { pick: "a", n: 2, many: ["x"], ok: true },
    })
  })
  it("reports missing required and wrongly typed fields", () => {
    expect(coerceFormContent(schema, {})).toEqual({ ok: false, missing: ["pick"] })
    expect(coerceFormContent(schema, { pick: "c" })).toEqual({ ok: false, missing: ["pick"] })
    expect(coerceFormContent(schema, { pick: "a", n: 1.5 })).toEqual({ ok: false, missing: ["n"] })
    expect(coerceFormContent(schema, { pick: "a", many: ["z"] })).toEqual({ ok: false, missing: ["many"] })
  })
})

describe("resolveHumanGateSurfaces", () => {
  it("defaults on, and one flag turns one surface off", async () => {
    expect(await resolveHumanGateSurfaces(async () => ({}))).toEqual({ approvals: true, runs: true })
    expect(await resolveHumanGateSurfaces(async () => ({ mcp: { humanGateRuns: false }, approvals: { uiBaseUrl: "https://c.example.test" } }))).toEqual({
      approvals: true,
      runs: false,
      approvalsUiBaseUrl: "https://c.example.test",
    })
  })
  it("turns every surface off with the global switch", async () => {
    expect(await resolveHumanGateSurfaces(async () => ({ mcp: { humanGate: false } }))).toEqual({ approvals: false, runs: false })
  })
  it("leaves the console URL out when the approvals surface is off", async () => {
    const approvals = { uiBaseUrl: "https://c.example.test" }
    expect(await resolveHumanGateSurfaces(async () => ({ mcp: { humanGate: false }, approvals }))).toEqual({ approvals: false, runs: false })
    expect(await resolveHumanGateSurfaces(async () => ({ mcp: { humanGateApprovals: false }, approvals }))).toEqual({ approvals: false, runs: true })
  })
})
