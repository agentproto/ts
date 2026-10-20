import { describe, expect, it } from "vitest"

import type { SessionDescriptor } from "../client/types.js"
import {
  continuationBadgeFor,
  continuationCount,
  continuationTooltipFor,
  previousContinuationSession,
  previousSessionTitle,
} from "./sessionContinuation.logic.js"

function session(over: Partial<SessionDescriptor> & { id: string }): SessionDescriptor {
  return {
    kind: "agent-cli",
    status: "running",
    startedAt: "2026-01-01T00:00:00Z",
    ...over,
  } as SessionDescriptor
}

const EMPTY: ContinuationLookupLike = () => undefined
type ContinuationLookupLike = (id: string) => SessionDescriptor | undefined

describe("previousContinuationSession", () => {
  it("resolves the descriptor named by continuedFrom", () => {
    const prev = session({ id: "prev" })
    expect(
      previousContinuationSession(session({ id: "cur", continuedFrom: "prev" }), id =>
        id === "prev" ? prev : undefined,
      ),
    ).toBe(prev)
  })
  it("is undefined on a base row", () => {
    expect(previousContinuationSession(session({ id: "cur" }), EMPTY)).toBeUndefined()
  })
  it("is undefined when the predecessor isn't in the store", () => {
    expect(
      previousContinuationSession(session({ id: "cur", continuedFrom: "gone" }), EMPTY),
    ).toBeUndefined()
  })
})

describe("continuationCount", () => {
  it("prefers the descriptor's continuationGeneration", () => {
    expect(
      continuationCount(
        session({ id: "cur", continuedFrom: "gone", continuationGeneration: 3 }),
        EMPTY,
      ),
    ).toBe(3)
  })
  it("counts one when the generation is missing and the predecessor is unknown", () => {
    expect(continuationCount(session({ id: "cur", continuedFrom: "gone" }), EMPTY)).toBe(1)
  })
  it("walks the chain when no generation is stamped", () => {
    const b = session({ id: "b", continuedFrom: "a" })
    const c = session({ id: "c", continuedFrom: "b" })
    const byId: Record<string, SessionDescriptor> = { b, c }
    // c2 → c → b → a(unknown): three hops counted through the lookup.
    expect(
      continuationCount(session({ id: "c2", continuedFrom: "c" }), id => byId[id]),
    ).toBe(3)
  })
  it("is undefined on a base row", () => {
    expect(continuationCount(session({ id: "cur" }), EMPTY)).toBeUndefined()
  })
})

describe("continuationBadgeFor", () => {
  it("renders the arrow badge with the count", () => {
    expect(
      continuationBadgeFor(session({ id: "cur", continuedFrom: "p", continuationGeneration: 3 })),
    ).toBe("↻ 3")
  })
  it("is undefined on a base row", () => {
    expect(continuationBadgeFor(session({ id: "cur" }))).toBeUndefined()
  })
})

describe("previousSessionTitle", () => {
  it("prefers the previous session's label, followed by its id tail", () => {
    // Continue-fresh copies the label VERBATIM, so the bare label would be
    // identical to this row's own — the id tail is what tells them apart.
    expect(
      previousSessionTitle(session({ id: "p", label: "pm-agentproto", title: "T" }), "p"),
    ).toBe("pm-agentproto (p)")
  })
  it("falls back to the title, also suffixed with the id tail", () => {
    expect(previousSessionTitle(session({ id: "p2", title: "The Title" }), "p2")).toBe(
      "The Title (p2)",
    )
  })
  it("trims a long id to its tail", () => {
    expect(
      previousSessionTitle(session({ id: "sess_0123456789ab", label: "same name" }), "sess_x"),
    ).toBe("same name (6789ab)")
  })
  it("returns the bare id when the predecessor has neither label nor title", () => {
    expect(previousSessionTitle(session({ id: "sess_abcdef" }), "sess_abcdef")).toBe(
      "sess_abcdef",
    )
  })
  it("falls back to the raw id when the predecessor is unknown", () => {
    expect(previousSessionTitle(undefined, "ses_gone")).toBe("ses_gone")
  })
})

describe("continuationTooltipFor", () => {
  const prev = session({ id: "p1", label: "pm-agentproto" })
  const lookup: ContinuationLookupLike = id => (id === "p1" ? prev : undefined)

  it("reads 'Continued 3 times — previous: <prev label> (<id tail>)'", () => {
    expect(
      continuationTooltipFor(
        session({ id: "c", continuedFrom: "p1", continuationGeneration: 3 }),
        lookup,
      ),
    ).toBe("Continued 3 times — previous: pm-agentproto (p1)")
  })
  it("uses the singular form for the first hop", () => {
    expect(
      continuationTooltipFor(
        session({ id: "c", continuedFrom: "p1", continuationGeneration: 1 }),
        lookup,
      ),
    ).toBe("Continued 1 time — previous: pm-agentproto (p1)")
  })
  it("falls back to the raw id for an unknown predecessor", () => {
    expect(
      continuationTooltipFor(session({ id: "c", continuedFrom: "ses_gone" }), EMPTY),
    ).toBe("Continued 1 time — previous: ses_gone")
  })
  it("is undefined on a base row", () => {
    expect(continuationTooltipFor(session({ id: "c" }), lookup)).toBeUndefined()
  })
})
