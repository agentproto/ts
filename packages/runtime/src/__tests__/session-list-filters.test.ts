import { describe, it, expect } from "vitest"
import type { SessionDescriptor } from "../sessions.js"
import {
  SessionListFilterError,
  applySessionListFilters,
  hasSessionListFilters,
  isNoiseSession,
  isReviewOrWorkflowSession,
  parseSessionListFilterParams,
  parseTimeBound,
  pickSessionListFilters,
  sortNewestActivityFirst,
} from "../session-list-filters.js"

const NOW = Date.parse("2026-10-09T12:00:00.000Z")
const ago = (ms: number): string => new Date(NOW - ms).toISOString()
const H = 3_600_000
const D = 24 * H

type Row = Pick<
  SessionDescriptor,
  | "id"
  | "kind"
  | "status"
  | "name"
  | "label"
  | "title"
  | "cwd"
  | "origin"
  | "adapterSlug"
  | "parentSessionId"
  | "lastActivityAt"
  | "startedAt"
>

function row(over: Partial<Row> & { id: string }): Row {
  return {
    kind: "agent-cli",
    status: "running",
    cwd: "/work/app",
    startedAt: ago(10 * D),
    ...over,
  } as Row
}

const rows: Row[] = [
  row({ id: "sess_main", label: "pygmalion brain", title: "Fix the checkout bug", lastActivityAt: ago(H), startedAt: ago(2 * D) }),
  row({ id: "sess_rev1", label: "review:agentik-studio:claims", origin: "review", parentSessionId: "sess_main", status: "killed", lastActivityAt: ago(2 * H), startedAt: ago(3 * H) }),
  row({ id: "sess_wf1", label: "wf:revise/reader-probe", origin: "workflow", status: "killed", lastActivityAt: ago(5 * D), startedAt: ago(5 * D) }),
  row({ id: "sess_cmd1", kind: "terminal", status: "exited", name: "scanner-tests8", cwd: "/work/scanner", lastActivityAt: ago(D), startedAt: ago(D) }),
  row({ id: "sess_cmd2", kind: "terminal", status: "killed", name: "mcp-smoke", startedAt: ago(8 * D), lastActivityAt: ago(8 * D) }),
  row({ id: "sess_cmdrun", kind: "terminal", status: "running", name: "dev-server", lastActivityAt: ago(H) }),
  row({ id: "sess_cmderr", kind: "terminal", status: "error", name: "flaky-test", lastActivityAt: ago(H) }),
  row({ id: "sess_tui", kind: "terminal", status: "killed", adapterSlug: "claude-code", label: "claude-code", lastActivityAt: ago(3 * D), startedAt: ago(3 * D) }),
  row({ id: "sess_child", label: "child-of-main", parentSessionId: "sess_main", lastActivityAt: ago(30 * 60_000), startedAt: ago(40 * 60_000) }),
  row({ id: "sess_old", label: "old chat", status: "killed", lastActivityAt: ago(20 * D), startedAt: ago(20 * D) }),
]

const ids = (list: readonly Row[]): string[] => list.map(r => r.id)
const apply = (input: Parameters<typeof applySessionListFilters>[1]): string[] =>
  ids(applySessionListFilters(rows, input, NOW))

describe("parseTimeBound", () => {
  it("parses relative ages against now", () => {
    expect(parseTimeBound("30m", "x", NOW)).toBe(NOW - 30 * 60_000)
    expect(parseTimeBound("24h", "x", NOW)).toBe(NOW - 24 * H)
    expect(parseTimeBound("7d", "x", NOW)).toBe(NOW - 7 * D)
    expect(parseTimeBound("2W", "x", NOW)).toBe(NOW - 14 * D)
    expect(parseTimeBound("90s", "x", NOW)).toBe(NOW - 90_000)
  })
  it("parses ISO instants", () => {
    expect(parseTimeBound("2026-10-01T00:00:00Z", "x", NOW)).toBe(Date.parse("2026-10-01T00:00:00Z"))
    expect(parseTimeBound("2026-10-01", "x", NOW)).toBe(Date.parse("2026-10-01"))
  })
  it("rejects garbage with the field name", () => {
    expect(() => parseTimeBound("yesterday", "updatedSince", NOW)).toThrow(SessionListFilterError)
    expect(() => parseTimeBound("yesterday", "updatedSince", NOW)).toThrow(/updatedSince/)
    expect(() => parseTimeBound("", "startedSince", NOW)).toThrow(SessionListFilterError)
  })
})

describe("applySessionListFilters", () => {
  it("no filters ⇒ every row, order preserved", () => {
    expect(apply({})).toEqual(ids(rows))
    expect(hasSessionListFilters({})).toBe(false)
    expect(hasSessionListFilters({ q: "  ", excludeNoise: false, rootOnly: false })).toBe(false)
  })

  it("q: case-insensitive substring over id, name, label, title and cwd", () => {
    expect(apply({ q: "CHECKOUT" })).toEqual(["sess_main"]) // title
    expect(apply({ q: "brain" })).toEqual(["sess_main"]) // label
    expect(apply({ q: "scanner-tests" })).toEqual(["sess_cmd1"]) // name
    expect(apply({ q: "/work/scanner" })).toEqual(["sess_cmd1"]) // cwd
    expect(apply({ q: "ess_rev" })).toEqual(["sess_rev1"]) // id, mid-string
    expect(apply({ q: "no-such-thing" })).toEqual([])
  })

  it("excludeLabelPrefix: string, array, comma list; case-sensitive prefix on label only", () => {
    expect(apply({ excludeLabelPrefix: "review:" })).not.toContain("sess_rev1")
    expect(apply({ excludeLabelPrefix: ["review:", "wf:"] })).not.toEqual(expect.arrayContaining(["sess_rev1"]))
    const both = apply({ excludeLabelPrefix: "review:,wf:" })
    expect(both).not.toContain("sess_rev1")
    expect(both).not.toContain("sess_wf1")
    expect(both).toContain("sess_main")
    // a session with no label is never excluded by a prefix
    expect(both).toContain("sess_cmd1")
    // "Review:" ≠ "review:"
    expect(apply({ excludeLabelPrefix: "Review:" })).toContain("sess_rev1")
  })

  it("excludeLabels: exact label match (session_follow's exclude.labels vocabulary)", () => {
    expect(apply({ excludeLabels: "old chat" })).not.toContain("sess_old")
    expect(apply({ excludeLabels: ["old"] })).toContain("sess_old") // not a substring match
    expect(apply({ excludeLabels: ["old chat", "claude-code"] })).not.toEqual(expect.arrayContaining(["sess_tui"]))
  })

  it("excludeKinds", () => {
    const out = apply({ excludeKinds: ["terminal"] })
    expect(out.every(id => !id.startsWith("sess_cmd") && id !== "sess_tui")).toBe(true)
    expect(out).toContain("sess_main")
    expect(apply({ excludeKinds: "agent-cli,terminal" })).toEqual([])
  })

  it("rootOnly drops children", () => {
    const out = apply({ rootOnly: true })
    expect(out).not.toContain("sess_rev1")
    expect(out).not.toContain("sess_child")
    expect(out).toContain("sess_main")
  })

  it("parentSessionId: direct children only", () => {
    expect(apply({ parentSessionId: "sess_main" }).sort()).toEqual(["sess_child", "sess_rev1"])
    expect(apply({ parentSessionId: "sess_nobody" })).toEqual([])
  })

  it("updatedSince uses lastActivityAt, falling back to startedAt", () => {
    expect(apply({ updatedSince: "3h" }).sort()).toEqual(
      ["sess_cmderr", "sess_cmdrun", "sess_child", "sess_main", "sess_rev1"].sort(),
    )
    const noActivity = [row({ id: "sess_fresh", startedAt: ago(H) }), row({ id: "sess_stale", startedAt: ago(9 * D) })]
    expect(ids(applySessionListFilters(noActivity, { updatedSince: "24h" }, NOW))).toEqual(["sess_fresh"])
  })

  it("startedSince uses startedAt only (a long-lived session with fresh activity is excluded)", () => {
    const out = apply({ startedSince: "6h" })
    expect(out).toContain("sess_rev1") // started 3h ago
    expect(out).not.toContain("sess_main") // started 2d ago, active 1h ago
    expect(apply({ startedSince: "2026-10-09T11:00:00Z" })).toContain("sess_child")
  })

  it("a bad time bound throws instead of silently matching nothing", () => {
    expect(() => apply({ updatedSince: "last week" })).toThrow(SessionListFilterError)
    expect(() => apply({ startedSince: "soon" })).toThrow(SessionListFilterError)
  })

  it("filters AND together", () => {
    expect(apply({ rootOnly: true, q: "checkout" })).toEqual(["sess_main"])
    expect(apply({ parentSessionId: "sess_main", excludeLabelPrefix: "review:" })).toEqual(["sess_child"])
    expect(apply({ q: "main", excludeKinds: "agent-cli" })).toEqual([])
  })
})

describe("excludeNoise preset", () => {
  it("drops review lanes, workflow stages and ended one-shot command runs — nothing else", () => {
    const out = apply({ excludeNoise: true }).sort()
    expect(out).toEqual(["sess_child", "sess_cmderr", "sess_cmdrun", "sess_main", "sess_old", "sess_tui"].sort())
  })

  it("matches by label prefix or by origin", () => {
    expect(isNoiseSession({ kind: "agent-cli", status: "running", label: "review:x:y" })).toBe(true)
    expect(isNoiseSession({ kind: "agent-cli", status: "running", label: "wf:stage" })).toBe(true)
    expect(isNoiseSession({ kind: "agent-cli", status: "running", origin: "review" })).toBe(true)
    expect(isNoiseSession({ kind: "agent-cli", status: "running", origin: "workflow" })).toBe(true)
    expect(isNoiseSession({ kind: "agent-cli", status: "running", label: "my review: notes" })).toBe(false)
  })

  it("keeps live commands, errored commands, agent TUIs and ordinary ended agent sessions", () => {
    expect(isNoiseSession({ kind: "terminal", status: "running" })).toBe(false)
    expect(isNoiseSession({ kind: "terminal", status: "error" })).toBe(false)
    expect(isNoiseSession({ kind: "terminal", status: "killed", adapterSlug: "claude-code" })).toBe(false)
    expect(isNoiseSession({ kind: "agent-cli", status: "killed", adapterSlug: "claude-code" })).toBe(false)
    expect(isNoiseSession({ kind: "terminal", status: "exited" })).toBe(true)
    expect(isNoiseSession({ kind: "command", status: "exited" })).toBe(true)
  })
})

describe("sortNewestActivityFirst", () => {
  it("orders by lastActivityAt (else startedAt) desc, ties by id, without mutating", () => {
    const input = [...rows]
    const sorted = sortNewestActivityFirst(input)
    expect(input.map(r => r.id)).toEqual(ids(rows))
    expect(sorted[0]!.id).toBe("sess_child") // 30m ago, newest activity
    expect(ids(sorted).slice(1, 4)).toEqual(["sess_cmderr", "sess_cmdrun", "sess_main"]) // 1h tie ⇒ id order
    const acts = sorted.map(r => Date.parse(r.lastActivityAt ?? r.startedAt))
    expect([...acts].sort((a, b) => b - a)).toEqual(acts)
  })
})

describe("parseSessionListFilterParams / pickSessionListFilters", () => {
  it("reads repeated and comma-separated list keys, booleans and strings", () => {
    const params = new URLSearchParams(
      "q=foo&excludeLabelPrefix=review:&excludeLabelPrefix=wf:,x:&excludeKinds=command&rootOnly=true&excludeNoise=1&parentSessionId=sess_a&updatedSince=24h&startedSince=2026-10-01",
    )
    expect(parseSessionListFilterParams(params)).toEqual({
      q: "foo",
      excludeLabelPrefix: ["review:", "wf:", "x:"],
      excludeKinds: ["command"],
      rootOnly: true,
      excludeNoise: true,
      parentSessionId: "sess_a",
      updatedSince: "24h",
      startedSince: "2026-10-01",
    })
  })
  it("absent or empty params produce no filters", () => {
    expect(parseSessionListFilterParams(new URLSearchParams("kind=all&q="))).toEqual({})
    expect(parseSessionListFilterParams(new URLSearchParams("rootOnly=false"))).toEqual({ rootOnly: false })
  })
  it("pickSessionListFilters keeps only filter keys", () => {
    expect(pickSessionListFilters({ q: "a", limit: 5, kind: "all" } as never)).toEqual({ q: "a" })
  })
})

describe("label (exact) and cwd (prefix) filters", () => {
  it("label keeps only exact, case-insensitive matches", () => {
    expect(apply({ label: "pygmalion brain" })).toEqual(["sess_main"])
    expect(apply({ label: "PYGMALION BRAIN" })).toEqual(["sess_main"])
    // A prefix of a label is not a match — that is `excludeLabelPrefix`'s job.
    expect(apply({ label: "pygmalion" })).toEqual([])
    expect(apply({ label: "review:agentik-studio:claims" })).toEqual(["sess_rev1"])
  })

  it("cwd keeps the directory itself and everything under it, not a sibling prefix", () => {
    expect(apply({ cwd: "/work/scanner" })).toEqual(["sess_cmd1"])
    // Every shared row's cwd lives under /work (default "/work/app").
    expect(apply({ cwd: "/work" })).toEqual(ids(rows))
    // "/work/app" must not match "/work/apple" — path-boundary aware.
    expect(applySessionListFilters(
      [row({ id: "sess_b", cwd: "/work/apple" }), row({ id: "sess_a", cwd: "/work/app" })],
      { cwd: "/work/app" },
      NOW,
    ).map(r => r.id)).toEqual(["sess_a"])
  })

  it("label and cwd AND with every other filter", () => {
    expect(apply({ label: "review:agentik-studio:claims", cwd: "/work/app" })).toEqual(["sess_rev1"])
    expect(
      applySessionListFilters(
        [
          row({ id: "sess_root", cwd: "/work/app" }),
          row({ id: "sess_kid", cwd: "/work/app", parentSessionId: "sess_root" }),
          row({ id: "sess_elsewhere", cwd: "/elsewhere" }),
        ],
        { cwd: "/work/app", rootOnly: true },
        NOW,
      ).map(r => r.id),
    ).toEqual(["sess_root"])
  })

  it("a row with no cwd never matches a cwd filter", () => {
    expect(applySessionListFilters([row({ id: "sess_nocwd", cwd: undefined })], { cwd: "/work" }, NOW)).toEqual([])
  })

  it("hasSessionListFilters and the HTTP param reader both see the new keys", () => {
    expect(hasSessionListFilters({ label: "x" })).toBe(true)
    expect(hasSessionListFilters({ cwd: "/x" })).toBe(true)
    expect(hasSessionListFilters({ label: "  " })).toBe(false)
    expect(parseSessionListFilterParams(new URLSearchParams("label=chat&cwd=/work/app"))).toEqual({
      label: "chat",
      cwd: "/work/app",
    })
    expect(pickSessionListFilters({ label: "chat", limit: 3 } as never)).toEqual({ label: "chat" })
  })
})

describe("isReviewOrWorkflowSession", () => {
  it("names exactly the review-lane / workflow-stage subset of the noise preset", () => {
    expect(isReviewOrWorkflowSession({ label: "review:pr-42" })).toBe(true)
    expect(isReviewOrWorkflowSession({ label: "wf:revise/reader-probe" })).toBe(true)
    expect(isReviewOrWorkflowSession({ origin: "review" })).toBe(true)
    expect(isReviewOrWorkflowSession({ origin: "workflow" })).toBe(true)
    // Ended one-shot command runs are noise too, but NOT this subset —
    // they must never be folded into a "reviews" group.
    expect(isReviewOrWorkflowSession({ label: "bash -lc …" })).toBe(false)
    expect(isReviewOrWorkflowSession({})).toBe(false)
  })
  it("isNoiseSession still covers review/workflow", () => {
    expect(isNoiseSession({ kind: "agent-cli", status: "killed", label: "review:pr-1", origin: "review" })).toBe(true)
    expect(isNoiseSession({ kind: "agent-cli", status: "killed", label: "chat", origin: "review" })).toBe(true)
  })
})
