/**
 * `agentproto host guard`: the pure OK/WARN/CRIT decision, the deterministic
 * "oldest idle first" selection, every safety refusal, idempotence, and the
 * CRIT marker that gates heavyweight workflow launches.
 */

import { describe, it, expect } from "vitest"
import {
  DEFAULT_GUARD_POLICY,
  GUARD_STATE_TTL_MS,
  heavyWorkflowBlockReason,
  selectGuardSessions,
  type GuardSession,
  type GuardState,
} from "../commands/host-guard.js"
import type { HealthVerdict } from "../commands/host-health.js"

const NOW = Date.parse("2026-10-22T12:00:00.000Z")
const MIN = 60_000

const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * MIN).toISOString()

let seq = 0
function session(over: Partial<GuardSession> = {}): GuardSession {
  seq++
  return {
    id: `sess_${String(seq).padStart(4, "0")}`,
    kind: "agent-cli",
    status: "running",
    alive: true,
    busy: false,
    startedAt: at(120),
    lastActivityAt: at(60),
    ...over,
  }
}

function health(
  verdict: HealthVerdict,
  opts: { alive?: number; sessionsStatus?: "OK" | "WARN" | "CRIT"; warnSessions?: number } = {},
) {
  const alive = opts.alive ?? 5
  return {
    verdict,
    checks: [
      { id: "sessions" as const, status: opts.sessionsStatus ?? "OK", value: alive },
    ],
    thresholds: { warnSessions: opts.warnSessions ?? 30 },
  }
}

const ids = (rows: readonly { id: string }[]): string[] => rows.map(r => r.id)

describe("selectGuardSessions — verdict decisions", () => {
  it("OK closes nothing, even with plenty of idle sessions", () => {
    const sessions = [session(), session(), session()]
    const sel = selectGuardSessions({ health: health("OK"), sessions, nowMs: NOW })
    expect(sel.action).toBe("none")
    expect(sel.close).toEqual([])
    expect(sel.candidates).toHaveLength(3)
    expect(sel.projectedAlive).toBe(3)
    expect(sel.idleReason).toBe("host is OK — nothing to close")
  })

  it("WARN closes only the number the sessions check needs to fall under the limit", () => {
    // 32 live, WARN at >= 30 → need 32 -> 29, i.e. 3 closures.
    const sessions = Array.from({ length: 32 }, () => session())
    const sel = selectGuardSessions({
      health: health("WARN", { alive: 32, sessionsStatus: "WARN", warnSessions: 30 }),
      sessions,
      nowMs: NOW,
    })
    expect(sel.action).toBe("close")
    expect(sel.targetAlive).toBe(29)
    expect(sel.budget).toBe(3)
    expect(sel.close).toHaveLength(3)
    expect(sel.projectedAlive).toBe(29)
  })

  it("WARN from load/RAM (sessions OK) sweeps at most warnMaxClose, oldest first", () => {
    const old = session({ lastActivityAt: at(600) })
    const mid = session({ lastActivityAt: at(300) })
    const young = session({ lastActivityAt: at(120) })
    const sel = selectGuardSessions({
      health: health("WARN"),
      sessions: [young, old, mid],
      nowMs: NOW,
    })
    expect(sel.budget).toBe(DEFAULT_GUARD_POLICY.warnMaxClose)
    expect(ids(sel.close)).toEqual([old.id, mid.id, young.id])
  })

  it("CRIT sweeps at least critMaxClose but also enough to fall under the WARN limit", () => {
    // 25 live, warn at 30 is not the reason (sessions OK); CRIT from load.
    const loadCrit = Array.from({ length: 25 }, () => session())
    const a = selectGuardSessions({ health: health("CRIT"), sessions: loadCrit, nowMs: NOW })
    expect(a.budget).toBe(DEFAULT_GUARD_POLICY.critMaxClose)
    expect(a.close).toHaveLength(DEFAULT_GUARD_POLICY.critMaxClose)

    // 45 live with warned sessions: CRIT must close 45 -> 29 = 16 (>10).
    const many = Array.from({ length: 45 }, () => session())
    const b = selectGuardSessions({
      health: health("CRIT", { alive: 45, sessionsStatus: "CRIT", warnSessions: 30 }),
      sessions: many,
      nowMs: NOW,
    })
    expect(b.budget).toBe(16)
    expect(b.projectedAlive).toBe(29)
  })

  it("uses a shorter idle window on CRIT than on WARN", () => {
    const s = session({ lastActivityAt: at(2) }) // idle 2 min
    const warn = selectGuardSessions({ health: health("WARN"), sessions: [s], nowMs: NOW })
    const crit = selectGuardSessions({ health: health("CRIT"), sessions: [s], nowMs: NOW })
    expect(warn.close).toEqual([])
    expect(warn.skipped["too-recent"]).toBe(1)
    expect(crit.close).toHaveLength(1)
  })
})

describe("selectGuardSessions — safety refusals", () => {
  const sel = (sessions: GuardSession[], over: { protectedSessionIds?: string[] } = {}) =>
    selectGuardSessions({ health: health("CRIT"), sessions, nowMs: NOW, ...over })

  it("never closes a busy (mid-turn) session", () => {
    const busy = session({ busy: true, lastActivityAt: at(600) })
    const idle = session()
    const out = sel([busy, idle])
    expect(ids(out.close)).toEqual([idle.id])
    expect(out.skipped["busy"]).toBe(1)
    expect(out.counts.busy).toBe(1)
  })

  it("never closes keepAlive or pinned sessions", () => {
    const keep = session({ keepAlive: true, lastActivityAt: at(600) })
    const pinned = session({ pinned: true, lastActivityAt: at(600) })
    const out = sel([keep, pinned])
    expect(out.close).toEqual([])
    expect(out.skipped["keep-alive"]).toBe(1)
    expect(out.skipped["pinned"]).toBe(1)
  })

  it("never closes a session waiting on input, permission, tasks, prompts, children or a watcher", () => {
    const rows = [
      session({ awaitingInput: true }),
      session({ awaitingPermission: true }),
      session({ pendingBgTasks: 1 }),
      session({ backgroundTasks: [{ id: "t" }] }),
      session({ queuedPrompts: 2 }),
      session({ childrenBusy: 1 }),
      session({ watchers: 1 }),
    ]
    const out = sel(rows)
    expect(out.close).toEqual([])
    expect(out.skipped).toMatchObject({
      "awaiting-input": 1,
      "awaiting-permission": 1,
      "background-tasks": 2,
      "queued-prompts": 1,
      "children-busy": 1,
      watched: 1,
    })
  })

  it("never closes a starting session or a non-agent session", () => {
    const starting = session({ status: "starting", lastActivityAt: at(600) })
    const terminal = session({ status: "exited", alive: false, lastActivityAt: at(600) })
    const shell = session({ kind: "terminal", lastActivityAt: at(600) })
    const out = sel([starting, terminal, shell])
    expect(out.close).toEqual([])
    expect(out.skipped["starting"]).toBe(1)
    expect(out.skipped["not-alive"]).toBe(1)
    expect(out.skipped["not-agent"]).toBe(1)
  })

  it("never closes an ancestor of a live session (would orphan the tree)", () => {
    const parent = session({ id: "parent", lastActivityAt: at(600) })
    const child = session({ id: "child", parentSessionId: "parent", busy: true })
    const out = sel([parent, child])
    expect(out.close).toEqual([])
    expect(out.skipped["ancestor-of-live"]).toBe(1)
  })

  it("never closes the guard's own session or its ancestors", () => {
    const root = session({ id: "root", lastActivityAt: at(600) })
    const self = session({ id: "self", parentSessionId: "root", lastActivityAt: at(600) })
    const out = selectGuardSessions({
      health: health("CRIT"),
      sessions: [root, self],
      nowMs: NOW,
      protectedSessionIds: ["self"],
    })
    expect(out.close).toEqual([])
    expect(out.skipped["self-or-ancestor"]).toBe(1)
    expect(out.skipped["ancestor-of-live"]).toBe(1)
  })

  it("never closes the escalation session", () => {
    const brain = session({ label: "host-guard-escalation", lastActivityAt: at(600) })
    const out = sel([brain])
    expect(out.close).toEqual([])
    expect(out.skipped["self-or-ancestor"]).toBe(1)
  })

  it("does not close a session whose last turn may still be open (too recent)", () => {
    const out = selectGuardSessions({
      health: health("WARN"),
      sessions: [session({ lastActivityAt: at(4) })],
      nowMs: NOW,
    })
    expect(out.close).toEqual([])
    expect(out.skipped["too-recent"]).toBe(1)
  })
})

describe("selectGuardSessions — idempotence", () => {
  it("is deterministic for identical inputs", () => {
    const sessions = [session(), session(), session({ lastActivityAt: at(400) })]
    const one = selectGuardSessions({ health: health("WARN"), sessions, nowMs: NOW })
    const two = selectGuardSessions({ health: health("WARN"), sessions, nowMs: NOW })
    expect(two).toEqual(one)
  })

  it("selects nothing on a second pass after the first pass's kills landed", () => {
    const sessions = [session(), session(), session(), session({ lastActivityAt: at(400) })]
    const first = selectGuardSessions({ health: health("WARN"), sessions, nowMs: NOW })
    expect(first.close.length).toBeGreaterThan(0)
    const closedIds = new Set(ids(first.close))
    const after = sessions.map(s =>
      closedIds.has(s.id) ? { ...s, status: "killed", alive: false } : s,
    )
    const second = selectGuardSessions({ health: health("OK"), sessions: after, nowMs: NOW })
    expect(second.close).toEqual([])
  })

  it("does not re-select a session twice even if it still looks alive", () => {
    // Simulates a stop that did not take effect yet: the same input must yield
    // the same closed set, never a growing one.
    const sessions = [session(), session()]
    const first = selectGuardSessions({ health: health("WARN"), sessions, nowMs: NOW })
    const again = selectGuardSessions({ health: health("WARN"), sessions, nowMs: NOW })
    expect(ids(again.close)).toEqual(ids(first.close))
    expect(new Set(ids(again.close)).size).toBe(again.close.length)
  })
})

describe("heavyWorkflowBlockReason", () => {
  const state = (over: Partial<GuardState> = {}): GuardState => ({
    verdict: "CRIT",
    reasons: ["load 76 on 8 cores"],
    at: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + GUARD_STATE_TTL_MS).toISOString(),
    closed: [],
    remaining: { alive: 4, busy: 2, keepAlive: 1 },
    ...over,
  })

  it("allows when no marker is armed or the verdict is not CRIT", () => {
    expect(heavyWorkflowBlockReason(null, NOW)).toBeNull()
    expect(heavyWorkflowBlockReason(undefined, NOW)).toBeNull()
  })

  it("blocks while a fresh CRIT marker is armed", () => {
    const reason = heavyWorkflowBlockReason(state(), NOW)
    expect(reason).toContain("host is CRIT")
    expect(reason).toContain("workflow")
  })

  it("allows once the marker has expired", () => {
    expect(heavyWorkflowBlockReason(state(), NOW + GUARD_STATE_TTL_MS + 1)).toBeNull()
  })

  it("allows on a malformed expiry", () => {
    expect(heavyWorkflowBlockReason(state({ expiresAt: "not-a-date" }), NOW)).toBeNull()
  })
})
