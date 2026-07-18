import { describe, expect, it, vi } from "vitest"

import { NoTranscriptError } from "../client/daemonClient.js"
import type { SessionEventRecord } from "../client/types.js"
import {
  DEFAULT_MAX_CHAIN_DEPTH,
  walkResumeChain,
  type ResumeChainFetchers,
  type ResumeLink,
} from "./resumeChain.logic.js"

function rec(seq: number, text: string): SessionEventRecord {
  return { seq, ts: "2026-01-01T00:00:00Z", kind: "text-delta", text }
}

/** Build fetchers from a fixed graph — a plain id → link/records map — so
 *  each test just declares the chain shape instead of wiring mocks by hand. */
function fetchersFrom(
  links: Record<string, ResumeLink | undefined>,
  eventsOrError: Record<string, readonly SessionEventRecord[] | Error>,
): ResumeChainFetchers & { calls: { getResumeLink: string[]; getAllEvents: string[] } } {
  const calls = { getResumeLink: [] as string[], getAllEvents: [] as string[] }
  return {
    calls,
    async getResumeLink(id) {
      calls.getResumeLink.push(id)
      return links[id]
    },
    async getAllEvents(id) {
      calls.getAllEvents.push(id)
      const entry = eventsOrError[id]
      if (entry instanceof Error) throw entry
      return entry ?? []
    },
  }
}

describe("walkResumeChain", () => {
  it("returns an empty chain when the session has no resumedFrom", async () => {
    const fetchers = fetchersFrom({}, {})
    const chain = await walkResumeChain({ id: "s1" }, fetchers)
    expect(chain).toEqual([])
    expect(fetchers.calls.getAllEvents).toHaveLength(0)
  })

  it("walks a single-hop chain and stops when the ancestor has no resumedFrom of its own", async () => {
    const fetchers = fetchersFrom(
      { a: { id: "a", resumedFrom: undefined } },
      { a: [rec(1, "hello from a")] },
    )
    const chain = await walkResumeChain(
      { id: "s2", resumedFrom: "a", resumeVia: "resumed via ACP" },
      fetchers,
    )
    expect(chain).toEqual([
      { sessionId: "a", resumeVia: "resumed via ACP", records: [rec(1, "hello from a")] },
    ])
  })

  it("walks a multi-hop chain oldest-last (walk order), attaching each segment's resumeVia to the CHILD's own resumeVia", async () => {
    // s3 --(resumed via ACP)--> b --(resumed via claude --resume)--> a --(root, no further link)
    const fetchers = fetchersFrom(
      {
        b: { id: "b", resumedFrom: "a", resumeVia: "resumed via claude --resume" },
        a: { id: "a", resumedFrom: undefined },
      },
      {
        b: [rec(1, "from b")],
        a: [rec(1, "from a")],
      },
    )
    const chain = await walkResumeChain(
      { id: "s3", resumedFrom: "b", resumeVia: "resumed via ACP" },
      fetchers,
    )
    expect(chain.map(s => s.sessionId)).toEqual(["b", "a"])
    expect(chain[0]?.resumeVia).toBe("resumed via ACP")
    expect(chain[1]?.resumeVia).toBe("resumed via claude --resume")
  })

  it("stops (with an unavailable marker) at an ancestor with no structured transcript, without walking further back", async () => {
    const fetchers = fetchersFrom(
      // If the walk incorrectly continued past "a", it would ask for "root"
      // — asserted absent below.
      { a: { id: "a", resumedFrom: "root" } },
      { a: new NoTranscriptError("a") },
    )
    const chain = await walkResumeChain({ id: "s2", resumedFrom: "a", resumeVia: "" }, fetchers)
    expect(chain).toEqual([{ sessionId: "a", resumeVia: "", unavailable: "no-transcript" }])
    expect(fetchers.calls.getResumeLink).toHaveLength(0)
  })

  it("marks a generic fetch failure distinctly from NoTranscriptError, and still stops the walk", async () => {
    const fetchers = fetchersFrom({}, { a: new Error("daemon unreachable") })
    const chain = await walkResumeChain({ id: "s2", resumedFrom: "a" }, fetchers)
    expect(chain).toEqual([{ sessionId: "a", resumeVia: "", unavailable: "fetch-error" }])
  })

  it("stops without marking unavailable when the ancestor's OWN resume-link lookup fails — its transcript loaded fine, we just can't see further back", async () => {
    const fetchers: ResumeChainFetchers = {
      getResumeLink: vi.fn().mockRejectedValue(new Error("boom")),
      getAllEvents: vi.fn().mockResolvedValue([rec(1, "x")]),
    }
    const chain = await walkResumeChain({ id: "s2", resumedFrom: "a" }, fetchers)
    expect(chain).toEqual([{ sessionId: "a", resumeVia: "", records: [rec(1, "x")] }])
  })

  it("caps the walk at the depth limit so a long or cyclic chain can't hang the panel", async () => {
    // A chain of 20 hops, each pointing to the next.
    const links: Record<string, ResumeLink> = {}
    const events: Record<string, readonly SessionEventRecord[]> = {}
    for (let i = 0; i < 20; i++) {
      const id = `s${i}`
      links[id] = { id, resumedFrom: `s${i + 1}` }
      events[id] = [rec(1, id)]
    }
    const fetchers = fetchersFrom(links, events)
    const chain = await walkResumeChain({ id: "root", resumedFrom: "s0" }, fetchers, 5)
    expect(chain).toHaveLength(5)
    expect(chain.map(s => s.sessionId)).toEqual(["s0", "s1", "s2", "s3", "s4"])
  })

  it("defaults the depth cap to DEFAULT_MAX_CHAIN_DEPTH", async () => {
    const links: Record<string, ResumeLink> = {}
    const events: Record<string, readonly SessionEventRecord[]> = {}
    for (let i = 0; i < DEFAULT_MAX_CHAIN_DEPTH + 10; i++) {
      const id = `s${i}`
      links[id] = { id, resumedFrom: `s${i + 1}` }
      events[id] = []
    }
    const fetchers = fetchersFrom(links, events)
    const chain = await walkResumeChain({ id: "root", resumedFrom: "s0" }, fetchers)
    expect(chain).toHaveLength(DEFAULT_MAX_CHAIN_DEPTH)
  })

  it("breaks a cycle rather than looping forever", async () => {
    // s2 resumedFrom a; a resumedFrom b; b resumedFrom a (cycle).
    const fetchers = fetchersFrom(
      {
        a: { id: "a", resumedFrom: "b" },
        b: { id: "b", resumedFrom: "a" },
      },
      { a: [rec(1, "a")], b: [rec(1, "b")] },
    )
    const chain = await walkResumeChain({ id: "s2", resumedFrom: "a" }, fetchers)
    expect(chain.map(s => s.sessionId)).toEqual(["a", "b"])
  })
})
