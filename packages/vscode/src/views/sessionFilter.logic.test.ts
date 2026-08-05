import { describe, expect, it } from "vitest"

import type { SessionDescriptor, WorkspacesConfig } from "../client/types.js"
import { UNKNOWN_ORIGIN_SLUG } from "./sessionsGroups.logic.js"
import {
  adapterIdentitiesIn,
  EMPTY_FILTER,
  filterSessions,
  filterSummary,
  isFilterActive,
  originIdentitiesIn,
  type SessionFilterState,
} from "./sessionFilter.logic.js"

function session(over: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "s1",
    kind: "agent-cli",
    workspaceSlug: "ws",
    command: "claude-code --print",
    pid: 123,
    status: "running",
    startedAt: "2026-01-01T00:00:00Z",
    ...over,
  }
}

const config: WorkspacesConfig = {
  version: 1,
  workspaces: [
    { slug: "studio", path: "/Code/studio", addedAt: "", updatedAt: "", label: "Agentik Studio" },
    { slug: "other", path: "/Code/other", addedAt: "", updatedAt: "" },
  ],
}

describe("isFilterActive", () => {
  it("false for EMPTY_FILTER", () => {
    expect(isFilterActive(EMPTY_FILTER)).toBe(false)
  })
  it("true when any array field is populated", () => {
    expect(isFilterActive({ ...EMPTY_FILTER, status: ["live"] })).toBe(true)
    expect(isFilterActive({ ...EMPTY_FILTER, workspaces: ["Agentik Studio"] })).toBe(true)
    expect(isFilterActive({ ...EMPTY_FILTER, adapters: ["claude-code"] })).toBe(true)
    expect(isFilterActive({ ...EMPTY_FILTER, origin: ["gate"] })).toBe(true)
  })
  it("false when `origin` is absent entirely (state persisted before the field existed)", () => {
    const legacyState = { status: [], workspaces: [], adapters: [], search: "" } as SessionFilterState
    expect(isFilterActive(legacyState)).toBe(false)
  })
  it("true when search is non-blank, false when search is only whitespace", () => {
    expect(isFilterActive({ ...EMPTY_FILTER, search: "foo" })).toBe(true)
    expect(isFilterActive({ ...EMPTY_FILTER, search: "   " })).toBe(false)
  })
})

describe("filterSessions", () => {
  it("returns every session unchanged when the filter is inactive", () => {
    const sessions = [session({ id: "a" }), session({ id: "b" })]
    expect(filterSessions(sessions, EMPTY_FILTER, config)).toEqual(sessions)
  })

  it("filters by status via the activityFor predicates", () => {
    const sessions = [
      session({ id: "live", status: "running" }),
      session({ id: "awaiting", status: "running", awaitingInput: true }),
      session({ id: "done", status: "exited" }),
    ]
    const state: SessionFilterState = { ...EMPTY_FILTER, status: ["done"] }
    expect(filterSessions(sessions, state, config).map(s => s.id)).toEqual(["done"])
  })

  it("isolates a session stopped mid-turn under 'stopped', not 'done'", () => {
    const sessions = [session({ id: "s", status: "killed", killedMidTurn: true })]
    expect(filterSessions(sessions, { ...EMPTY_FILTER, status: ["stopped"] }, config).map(s => s.id)).toEqual([
      "s",
    ])
    expect(filterSessions(sessions, { ...EMPTY_FILTER, status: ["done"] }, config)).toEqual([])
  })

  it("treats a session killed while idle after finishing a turn as 'done', not 'stopped'", () => {
    const sessions = [session({ id: "s", status: "killed", killedMidTurn: false, turnsCompleted: 1 })]
    expect(filterSessions(sessions, { ...EMPTY_FILTER, status: ["done"] }, config).map(s => s.id)).toEqual([
      "s",
    ])
    expect(filterSessions(sessions, { ...EMPTY_FILTER, status: ["stopped"] }, config)).toEqual([])
  })

  it("classifies an errored session under 'failed'", () => {
    const sessions = [session({ id: "s", status: "error" })]
    expect(filterSessions(sessions, { ...EMPTY_FILTER, status: ["failed"] }, config).map(s => s.id)).toEqual([
      "s",
    ])
  })

  it("keeps a running session under 'live' and out of 'stopped'", () => {
    const sessions = [session({ id: "s", status: "running" })]
    expect(filterSessions(sessions, { ...EMPTY_FILTER, status: ["live"] }, config).map(s => s.id)).toEqual([
      "s",
    ])
    expect(filterSessions(sessions, { ...EMPTY_FILTER, status: ["stopped"] }, config)).toEqual([])
  })

  it("filters by workspace label, resolved via cwd against the config", () => {
    const sessions = [
      session({ id: "in-studio", cwd: "/Code/studio/packages/vscode" }),
      session({ id: "in-other", cwd: "/Code/other" }),
    ]
    const state: SessionFilterState = { ...EMPTY_FILTER, workspaces: ["Agentik Studio"] }
    expect(filterSessions(sessions, state, config).map(s => s.id)).toEqual(["in-studio"])
  })

  it("filters by adapter identity (adapterSlug ?? kind)", () => {
    const sessions = [
      session({ id: "cc", adapterSlug: "claude-code" }),
      session({ id: "term", adapterSlug: undefined, kind: "terminal" }),
    ]
    const state: SessionFilterState = { ...EMPTY_FILTER, adapters: ["terminal"] }
    expect(filterSessions(sessions, state, config).map(s => s.id)).toEqual(["term"])
  })

  it("search matches case-insensitively over label, command, cwd, id", () => {
    const sessions = [
      session({ id: "s1", label: "Sales Analysis" }),
      session({ id: "s2", command: "npm run BUILD" }),
      session({ id: "s3", cwd: "/Code/Widgets" }),
      session({ id: "MATCH-ME" }),
      session({ id: "s5", label: "unrelated" }),
    ]
    const state: SessionFilterState = { ...EMPTY_FILTER, search: "sales" }
    expect(filterSessions(sessions, state, config).map(s => s.id)).toEqual(["s1"])

    expect(
      filterSessions(sessions, { ...EMPTY_FILTER, search: "build" }, config).map(s => s.id),
    ).toEqual(["s2"])
    expect(
      filterSessions(sessions, { ...EMPTY_FILTER, search: "widgets" }, config).map(s => s.id),
    ).toEqual(["s3"])
    expect(
      filterSessions(sessions, { ...EMPTY_FILTER, search: "match-me" }, config).map(s => s.id),
    ).toEqual(["MATCH-ME"])
  })

  it("combines predicates with AND", () => {
    const sessions = [
      session({ id: "match", status: "running", adapterSlug: "claude-code" }),
      session({ id: "wrong-adapter", status: "running", adapterSlug: "other" }),
      session({ id: "wrong-status", status: "exited", adapterSlug: "claude-code" }),
    ]
    const state: SessionFilterState = { ...EMPTY_FILTER, status: ["live"], adapters: ["claude-code"] }
    expect(filterSessions(sessions, state, config).map(s => s.id)).toEqual(["match"])
  })

  it("parent-retention: keeps a non-matching ancestor when a descendant survives", () => {
    const sessions = [
      session({ id: "orchestrator", status: "running", label: "orchestrator" }),
      session({ id: "worker", parentSessionId: "orchestrator", status: "exited", label: "target-worker" }),
    ]
    const state: SessionFilterState = { ...EMPTY_FILTER, search: "target-worker" }
    const result = filterSessions(sessions, state, config)
    expect(result.map(s => s.id).sort()).toEqual(["orchestrator", "worker"])
  })

  it("parent-retention applies transitively across multiple levels", () => {
    const sessions = [
      session({ id: "root", status: "running" }),
      session({ id: "mid", parentSessionId: "root", status: "running" }),
      session({ id: "leaf", parentSessionId: "mid", status: "exited", label: "needle" }),
    ]
    const state: SessionFilterState = { ...EMPTY_FILTER, search: "needle" }
    expect(filterSessions(sessions, state, config).map(s => s.id).sort()).toEqual(["leaf", "mid", "root"])
  })

  it("drops a sibling subtree that has no matching descendant", () => {
    const sessions = [
      session({ id: "orchestrator", status: "running" }),
      session({ id: "matching-child", parentSessionId: "orchestrator", label: "needle" }),
      session({ id: "other-child", parentSessionId: "orchestrator", label: "unrelated" }),
    ]
    const state: SessionFilterState = { ...EMPTY_FILTER, search: "needle" }
    expect(filterSessions(sessions, state, config).map(s => s.id).sort()).toEqual([
      "matching-child",
      "orchestrator",
    ])
  })

  it("returns an empty list when nothing matches and nothing has a matching descendant", () => {
    const sessions = [session({ id: "a" }), session({ id: "b" })]
    const state: SessionFilterState = { ...EMPTY_FILTER, search: "nope" }
    expect(filterSessions(sessions, state, config)).toEqual([])
  })

  it("filters by origin, falling back to UNKNOWN_ORIGIN_SLUG for an originless session", () => {
    const sessions = [
      session({ id: "gate", origin: "gate" }),
      session({ id: "human", origin: "claude-code" }),
      session({ id: "none" }),
    ]
    expect(
      filterSessions(sessions, { ...EMPTY_FILTER, origin: ["gate"] }, config).map(s => s.id),
    ).toEqual(["gate"])
    expect(
      filterSessions(sessions, { ...EMPTY_FILTER, origin: [UNKNOWN_ORIGIN_SLUG] }, config).map(s => s.id),
    ).toEqual(["none"])
  })

  it("treats a state object missing the `origin` key (pre-existing persisted state) as no origin filter", () => {
    const sessions = [session({ id: "a", origin: "gate" })]
    const legacyState = { status: [], workspaces: [], adapters: [], search: "" } as SessionFilterState
    expect(filterSessions(sessions, legacyState, config)).toEqual(sessions)
  })

  describe("hideMachineSessions default (agentproto.hideMachineSessions)", () => {
    const sessions = [
      session({ id: "gate", origin: "gate" }),
      session({ id: "human", origin: "claude-code" }),
    ]

    it("off (default option): a machine-origin session is not filtered out", () => {
      expect(filterSessions(sessions, EMPTY_FILTER, config).map(s => s.id).sort()).toEqual([
        "gate",
        "human",
      ])
    })

    it("on, no explicit origin filter: excludes machine-origin sessions", () => {
      expect(
        filterSessions(sessions, EMPTY_FILTER, config, { hideMachineSessions: true }).map(s => s.id),
      ).toEqual(["human"])
    })

    it("on, but the operator explicitly asked for gate sessions: the explicit filter wins", () => {
      const state: SessionFilterState = { ...EMPTY_FILTER, origin: ["gate"] }
      expect(
        filterSessions(sessions, state, config, { hideMachineSessions: true }).map(s => s.id),
      ).toEqual(["gate"])
    })

    it("on, operator filtered to a human origin: machine sessions already excluded by that filter", () => {
      const state: SessionFilterState = { ...EMPTY_FILTER, origin: ["claude-code"] }
      expect(
        filterSessions(sessions, state, config, { hideMachineSessions: true }).map(s => s.id),
      ).toEqual(["human"])
    })

    it("on, every session is machine-origin and nothing else filters: returns empty, not the unfiltered list", () => {
      const allGate = [session({ id: "g1", origin: "gate" }), session({ id: "g2", origin: "gate" })]
      expect(filterSessions(allGate, EMPTY_FILTER, config, { hideMachineSessions: true })).toEqual([])
    })

    it("keeps a human ancestor of a machine-origin descendant's match irrelevant — parent-retention still applies to the default", () => {
      const withChild = [
        session({ id: "root", origin: "claude-code" }),
        session({ id: "gate-child", origin: "gate", parentSessionId: "root" }),
      ]
      // The gate child itself is hidden by the default and has no matching
      // descendant of its own, so only the (non-machine) root survives.
      expect(
        filterSessions(withChild, EMPTY_FILTER, config, { hideMachineSessions: true }).map(s => s.id),
      ).toEqual(["root"])
    })
  })
})

describe("originIdentitiesIn", () => {
  it("collects distinct origin ?? UNKNOWN_ORIGIN_SLUG values, sorted", () => {
    const sessions = [
      session({ origin: "vscode" }),
      session({ id: "s2" }), // no origin
      session({ id: "s3", origin: "gate" }),
    ]
    expect(originIdentitiesIn(sessions)).toEqual(["gate", UNKNOWN_ORIGIN_SLUG, "vscode"])
  })
  it("returns an empty array for an empty session list", () => {
    expect(originIdentitiesIn([])).toEqual([])
  })
})

describe("adapterIdentitiesIn", () => {
  it("collects distinct adapterSlug ?? kind values, sorted", () => {
    const sessions = [
      session({ adapterSlug: "claude-code" }),
      session({ adapterSlug: undefined, kind: "terminal" }),
      session({ adapterSlug: "claude-code" }),
    ]
    expect(adapterIdentitiesIn(sessions)).toEqual(["claude-code", "terminal"])
  })
  it("returns an empty array for an empty session list", () => {
    expect(adapterIdentitiesIn([])).toEqual([])
  })
})

describe("filterSummary", () => {
  it("returns an empty string when inactive", () => {
    expect(filterSummary(EMPTY_FILTER)).toBe("")
  })
  it("summarizes a single dimension", () => {
    expect(filterSummary({ ...EMPTY_FILTER, status: ["live", "awaiting"] })).toBe(
      "status: live, awaiting",
    )
  })
  it("joins multiple active dimensions with a middle dot", () => {
    const state: SessionFilterState = {
      status: ["live"],
      workspaces: ["Agentik Studio"],
      adapters: [],
      search: "sales",
    }
    expect(filterSummary(state)).toBe('status: live · workspace: Agentik Studio · search: "sales"')
  })
  it("ignores whitespace-only search", () => {
    expect(filterSummary({ ...EMPTY_FILTER, search: "   " })).toBe("")
  })
  it("summarizes the origin dimension", () => {
    expect(filterSummary({ ...EMPTY_FILTER, origin: ["gate"] })).toBe("origin: gate")
  })
  it("omits origin when the state predates the field entirely", () => {
    const legacyState = { status: [], workspaces: [], adapters: [], search: "" } as SessionFilterState
    expect(filterSummary(legacyState)).toBe("")
  })
})
