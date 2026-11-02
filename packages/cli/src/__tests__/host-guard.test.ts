/**
 * `agentproto host guard`: the pure OK/WARN/CRIT decision, the deterministic
 * "oldest idle first" selection, every safety refusal, idempotence, and the
 * CRIT marker that gates heavyweight workflow launches.
 */

import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import {
  DEFAULT_GUARD_POLICY,
  GUARD_STATE_TTL_MS,
  heavyWorkflowBlockReason,
  inspectWorktree,
  readGuardState,
  recheckGuardCandidate,
  runHostGuard,
  selectGuardSessions,
  type GuardSession,
  type GuardState,
} from "../commands/host-guard.js"
import type { HealthVerdict } from "../commands/host-health.js"

// ── I/O mocks for the runner tests ──────────────────────────────────
const io = vi.hoisted(() => ({
  verdict: "OK" as "OK" | "WARN" | "CRIT",
  sessions: [] as unknown[],
  /** Called before each reap so a test can mutate the live list. */
  onBeforeReap: undefined as undefined | ((id: string) => void),
  reaps: [] as string[],
  kills: [] as string[],
  reapFails: new Set<string>(),
}))

vi.mock("../commands/_daemon-helpers.js", () => ({
  discoverDaemon: async () => ({ found: { url: "http://daemon.test", token: "t" } }),
  printNoDaemonError: () => undefined,
  httpGetJson: async () => ({ sessions: io.sessions }),
  httpPostJson: async (url: string) => {
    const m = /\/sessions\/([^/]+)\/(reap|kill)$/.exec(url)
    if (!m) return {}
    const id = decodeURIComponent(m[1] as string)
    if (m[2] === "kill") {
      io.kills.push(id)
      return {}
    }
    io.onBeforeReap?.(id)
    if (io.reapFails.has(id)) throw new Error("HTTP 500")
    io.reaps.push(id)
    io.sessions = (io.sessions as { id: string }[]).map(s =>
      s.id === id ? { ...s, status: "killed", alive: false, endedReason: "guard-reaped" } : s,
    )
    return {}
  },
}))

vi.mock("../commands/host.js", () => ({
  gatherHealthInput: async () => ({}),
}))

vi.mock("../commands/host-health.js", async importOriginal => {
  const orig = await importOriginal<typeof import("../commands/host-health.js")>()
  return {
    ...orig,
    computeHostHealth: () => ({
      verdict: io.verdict,
      reasons: io.verdict === "OK" ? [] : ["load high"],
      checks: [{ id: "sessions", status: "OK", value: 5 }],
      thresholds: { warnSessions: 30 },
    }),
  }
})

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

  it("applies the absolute 900 s CRIT floor, even when --crit-min-idle asks for less", () => {
    // 10 min idle: past the WARN window (300 s) but under the CRIT floor.
    const s = session({ lastActivityAt: at(10) })
    const warn = selectGuardSessions({ health: health("WARN"), sessions: [s], nowMs: NOW })
    const crit = selectGuardSessions({ health: health("CRIT"), sessions: [s], nowMs: NOW })
    const forced = selectGuardSessions({
      health: health("CRIT"),
      sessions: [s],
      nowMs: NOW,
      policy: { critMinIdleSec: 60 },
    })
    expect(warn.close).toHaveLength(1)
    expect(crit.close).toEqual([])
    expect(crit.skipped["too-recent"]).toBe(1)
    expect(forced.close).toEqual([])
    expect(forced.skipped["too-recent"]).toBe(1)
  })

  it("a 40 min idle, clean session is eligible on CRIT", () => {
    const s = session({ lastActivityAt: at(40) })
    const crit = selectGuardSessions({ health: health("CRIT"), sessions: [s], nowMs: NOW })
    expect(ids(crit.close)).toEqual([s.id])
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

  it("never closes a parent with a live child (child-alive)", () => {
    const parent = session({ id: "parent", lastActivityAt: at(600) })
    const child = session({ id: "child", parentSessionId: "parent", busy: true })
    const out = sel([parent, child])
    expect(out.close).toEqual([])
    expect(out.skipped["child-alive"]).toBe(1)
  })

  it("never closes an ancestor of a live session (would orphan the tree)", () => {
    // An intermediate row already died; the live grandchild still makes the
    // root an ancestor that must not be reaped.
    const root = session({ id: "root", lastActivityAt: at(600) })
    const gone = session({ id: "gone", parentSessionId: "root", status: "exited", alive: false })
    const child = session({ id: "child", parentSessionId: "gone", busy: true })
    const out = sel([root, gone, child])
    expect(out.close).toEqual([])
    expect(out.skipped["ancestor-of-live"]).toBe(1)
    expect(out.skipped["not-alive"]).toBe(1)
  })

  it("never closes a dirty or unpushed worktree (work-in-flight)", () => {
    const dirty = session({ id: "dirty", lastActivityAt: at(600), worktreeState: { dirty: true, unpushed: false } })
    const unpushed = session({ id: "unpushed", lastActivityAt: at(600), worktreeState: { dirty: false, unpushed: true } })
    const unknown = session({ id: "unknown", lastActivityAt: at(600), worktreeState: { dirty: false, unpushed: false, unknown: true } })
    const clean = session({ id: "clean", lastActivityAt: at(600), worktreeState: { dirty: false, unpushed: false } })
    const out = sel([dirty, unpushed, unknown, clean])
    expect(ids(out.close)).toEqual([clean.id])
    expect(out.skipped["work-in-flight"]).toBe(3)
  })

  it("never closes an active fix/exec/diag session younger than 2 h (work-in-flight)", () => {
    const fixPr = session({ id: "fix-pr", label: "fix-pr-2445", lastActivityAt: at(112 / 60) })
    const exec = session({ id: "exec", label: "exec-argv", lastActivityAt: at(90) })
    const diag = session({ id: "diag", label: "diag-host", lastActivityAt: at(30) })
    const stale = session({ id: "stale", label: "fix-pr-1", lastActivityAt: at(150) })
    const out = sel([fixPr, exec, diag, stale])
    expect(ids(out.close)).toEqual([stale.id])
    expect(out.skipped["work-in-flight"]).toBe(3)
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
    expect(out.skipped["child-alive"]).toBe(1)
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

describe("selectGuardSessions — unknown idle time", () => {
  it("clamps idleSec to a finite number when a session has no timestamps", () => {
    const s = session({ startedAt: undefined, lastActivityAt: undefined })
    const sel = selectGuardSessions({ health: health("WARN"), sessions: [s], nowMs: NOW })
    expect(Number.isFinite(sel.candidates[0]?.idleSec)).toBe(true)
    expect(JSON.parse(JSON.stringify(sel.candidates[0])).idleSec).not.toBeNull()
  })
})

describe("inspectWorktree", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "host-guard-git-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("flags a dirty worktree", async () => {
    execFileSync("git", ["init", "-q"], { cwd: dir })
    await writeFile(join(dir, "work.txt"), "in progress\n")
    const state = await inspectWorktree(dir)
    expect(state.dirty).toBe(true)
    // No upstream on a fresh repo → conservative "cannot prove clean".
    expect(state.unknown).toBe(true)
  })

  it("keeps the session when git cannot answer", async () => {
    const state = await inspectWorktree(join(dir, "does-not-exist"))
    expect(state.unknown).toBe(true)
  })
})

describe("recheckGuardCandidate", () => {
  const opts = { verdict: "CRIT" as HealthVerdict, nowMs: NOW }

  it("allows a session that is still idle", () => {
    const s = session()
    expect(recheckGuardCandidate(s.id, [s], opts)).toBeNull()
  })

  it("refuses a session that started a turn after the snapshot", () => {
    const s = session()
    expect(recheckGuardCandidate(s.id, [{ ...s, busy: true }], opts)).toBe("busy")
    expect(recheckGuardCandidate(s.id, [{ ...s, queuedPrompts: 1 }], opts)).toBe("queued-prompts")
    expect(recheckGuardCandidate(s.id, [{ ...s, watchers: 1 }], opts)).toBe("watched")
    expect(recheckGuardCandidate(s.id, [{ ...s, lastActivityAt: at(0) }], opts)).toBe("too-recent")
  })

  it("refuses a session that vanished or is no longer alive", () => {
    const s = session()
    expect(recheckGuardCandidate(s.id, [], opts)).toBe("not-alive")
    expect(recheckGuardCandidate(s.id, [{ ...s, alive: false, status: "killed" }], opts)).toBe("not-alive")
  })

  it("refuses a session that became an ancestor of a live session", () => {
    const parent = session({ id: "p" })
    const child = session({ id: "c", parentSessionId: "p" })
    expect(recheckGuardCandidate("p", [parent, child], opts)).toBe("child-alive")
  })
})

describe("runHostGuard — I/O runner", () => {
  let dir: string
  let statePath: string
  let out = ""

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "host-guard-test-"))
    statePath = join(dir, "state.json")
    io.verdict = "OK"
    io.sessions = []
    io.onBeforeReap = undefined
    io.reaps = []
    io.kills = []
    io.reapFails = new Set()
    out = ""
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      out += String(chunk)
      return true
    }) as typeof process.stdout.write)
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  const run = (extra: string[] = []) =>
    runHostGuard(["--json", "--no-log", "--settle", "0", "--no-escalate", "--state", statePath, ...extra])

  // Real wall-clock "now" is used by the runner, so build rows relative to it.
  const idleRow = (id: string, over: Partial<GuardSession> = {}): GuardSession => ({
    id,
    kind: "agent-cli",
    status: "running",
    alive: true,
    busy: false,
    startedAt: new Date(Date.now() - 600 * MIN).toISOString(),
    lastActivityAt: new Date(Date.now() - 300 * MIN).toISOString(),
    ...over,
  })

  it("OK: closes nothing and leaves no marker", async () => {
    io.sessions = [idleRow("a")]
    expect(await run()).toBe(0)
    expect(io.reaps).toEqual([])
    expect(await readGuardState(statePath)).toBeNull()
  })

  it("WARN: reaps oldest idle sessions via the reap route, never kill", async () => {
    io.verdict = "WARN"
    io.sessions = [
      idleRow("new", { lastActivityAt: new Date(Date.now() - 10 * MIN).toISOString() }),
      idleRow("old"),
    ]
    await run()
    expect(io.reaps).toEqual(["old", "new"])
    expect(io.kills).toEqual([])
  })

  it("reaps a clean session idle 40 min on CRIT (guard-reaped, not operator-stopped)", async () => {
    io.verdict = "CRIT"
    io.sessions = [idleRow("clean", { lastActivityAt: new Date(Date.now() - 40 * MIN).toISOString() })]
    await run()
    expect(io.reaps).toEqual(["clean"])
    expect(io.kills).toEqual([])
  })

  it("spares an active fix-pr session at 112 s (work-in-flight)", async () => {
    io.verdict = "CRIT"
    io.sessions = [
      idleRow("fix", {
        label: "fix-pr-2445",
        lastActivityAt: new Date(Date.now() - 112 * 1000).toISOString(),
      }),
    ]
    await run()
    expect(io.reaps).toEqual([])
    const report = JSON.parse(out)
    expect(report.selection.skipped["work-in-flight"]).toBe(1)
  })

  it("spares a session whose worktree is dirty (work-in-flight)", async () => {
    io.verdict = "CRIT"
    io.sessions = [
      idleRow("dirty", { worktreeState: { dirty: true, unpushed: false } }),
      idleRow("clean"),
    ]
    await run()
    expect(io.reaps).toEqual(["clean"])
    expect(JSON.parse(out).selection.skipped["work-in-flight"]).toBe(1)
  })

  it("dry-run: decides but reaps nothing and writes no marker", async () => {
    io.verdict = "CRIT"
    io.sessions = [idleRow("a")]
    await run(["--dry-run"])
    expect(io.reaps).toEqual([])
    expect(await readGuardState(statePath)).toBeNull()
    expect(JSON.parse(out).selection.close).toHaveLength(1)
  })

  it("never reaps a session that became busy between snapshot and reap", async () => {
    io.verdict = "WARN"
    io.sessions = [idleRow("a"), idleRow("b", { lastActivityAt: new Date(Date.now() - 200 * MIN).toISOString() })]
    // Right after the first re-validation passes, "b" is not yet touched; flip
    // "b" to busy before its own re-check by mutating when "a" is reaped.
    io.onBeforeReap = id => {
      if (id === "a") {
        io.sessions = (io.sessions as GuardSession[]).map(s => (s.id === "b" ? { ...s, busy: true } : s))
      }
    }
    await run()
    expect(io.reaps).toEqual(["a"])
    const report = JSON.parse(out)
    expect(report.closed.map((c: { id: string }) => c.id)).toEqual(["a"])
    expect(report.failed[0].id).toBe("b")
    expect(report.failed[0].error).toContain("busy")
  })

  it("records a failed reap and keeps going", async () => {
    io.verdict = "WARN"
    io.sessions = [idleRow("a"), idleRow("b", { lastActivityAt: new Date(Date.now() - 200 * MIN).toISOString() })]
    io.reapFails.add("b")
    await run()
    expect(io.reaps).toEqual(["a"])
    const report = JSON.parse(out)
    expect(report.failed.map((f: { id: string }) => f.id)).toEqual(["b"])
  })

  it("CRIT: arms the marker with post-cleanup remaining counts; later OK clears it", async () => {
    io.verdict = "CRIT"
    io.sessions = [idleRow("a"), idleRow("b", { busy: true })]
    await run()
    expect(io.reaps).toEqual(["a"])
    const state = await readGuardState(statePath)
    expect(state?.verdict).toBe("CRIT")
    expect(state?.closed.map(c => c.id)).toEqual(["a"])
    expect(state?.remaining).toEqual({ alive: 1, busy: 1, keepAlive: 0 })

    io.verdict = "OK"
    await run()
    expect(await readGuardState(statePath)).toBeNull()
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
