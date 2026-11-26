import { describe, it, expect } from "vitest"
import { buildApprovalUrl, coerceFormContent, type ElicitRequestedSchema } from "../mcp-modern/index.js"
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
  ])("refuses %s", base => {
    expect(buildApprovalUrl(base, "apr_1")).toBeUndefined()
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
})
