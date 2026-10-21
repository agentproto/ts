import { describe, expect, it } from "vitest"
import { stripOwnCallerStamp } from "../session-continue-fresh.js"
import { CALLER_SESSION_ID_HEADER, type SessionDescriptor } from "../sessions.js"

type Servers = NonNullable<SessionDescriptor["mcpServers"]>

const PREV = "sess_prev"
const BASE = "http://127.0.0.1:4000/mcp"

function mount(entry: Record<string, unknown>): Servers {
  return [{ name: "agentproto", transport: "http", ...entry }] as unknown as Servers
}

describe("stripOwnCallerStamp", () => {
  it("strips a header-only identity stamp with a matching query", () => {
    const out = stripOwnCallerStamp(
      mount({ ref: `${BASE}?callerSessionId=${PREV}`, headers: { [CALLER_SESSION_ID_HEADER]: PREV } }),
      PREV,
    )!
    expect(out[0]!.ref).toBe(BASE)
    expect(out[0]!.headers).toBeUndefined()
  })

  it("strips a header-only identity stamp when the query is absent", () => {
    const out = stripOwnCallerStamp(
      mount({ ref: BASE, headers: { [CALLER_SESSION_ID_HEADER]: PREV } }),
      PREV,
    )!
    expect(out[0]!.ref).toBe(BASE)
    expect(out[0]!.headers).toBeUndefined()
  })

  it("strips our header but keeps a foreign query pin", () => {
    const out = stripOwnCallerStamp(
      mount({ ref: `${BASE}?callerSessionId=sess_other`, headers: { [CALLER_SESSION_ID_HEADER]: PREV } }),
      PREV,
    )!
    expect(out[0]!.ref).toBe(`${BASE}?callerSessionId=sess_other`)
    expect(out[0]!.headers).toBeUndefined()
  })

  it("strips our header and keeps other headers", () => {
    const out = stripOwnCallerStamp(
      mount({
        ref: `${BASE}?callerSessionId=${PREV}`,
        headers: { [CALLER_SESSION_ID_HEADER]: PREV, authorization: "Bearer x" },
      }),
      PREV,
    )!
    expect(out[0]!.ref).toBe(BASE)
    expect(out[0]!.headers).toEqual({ authorization: "Bearer x" })
  })

  it("keeps a foreign identity header", () => {
    const entry = mount({ ref: BASE, headers: { [CALLER_SESSION_ID_HEADER]: "sess_other" } })
    const out = stripOwnCallerStamp(entry, PREV)!
    expect(out[0]!.headers).toEqual({ [CALLER_SESSION_ID_HEADER]: "sess_other" })
  })

  it("strips a query-only stamp (regression)", () => {
    const out = stripOwnCallerStamp(mount({ ref: `${BASE}?callerSessionId=${PREV}` }), PREV)!
    expect(out[0]!.ref).toBe(BASE)
    expect(out[0]!.headers).toBeUndefined()
  })

  it("strips the header even when the ref is not a parseable URL", () => {
    const out = stripOwnCallerStamp(
      mount({ ref: "not a url", headers: { [CALLER_SESSION_ID_HEADER]: PREV } }),
      PREV,
    )!
    expect(out[0]!.ref).toBe("not a url")
    expect(out[0]!.headers).toBeUndefined()
  })
})
