import { describe, expect, it, vi } from "vitest"
import {
  attributeProcesses,
  buildLabeledStatsReport,
  createProcessStatsService,
  createProvisionTracker,
  normalizeCommand,
  parseEtime,
  parseMeminfoAvailable,
  parseProcStat,
  parsePsTable,
  parseVmStatAvailable,
  psArgs,
  statsDetailOf,
  trackWorktreeProvision,
  withSessionStats,
  type HostInfo,
  type ProcRow,
  type StatsSessionDescriptor,
} from "../process-stats.js"

const MACOS_PS = `
  1     0     0   9000  0.0 12-03:04:05 /sbin/launchd
 100     1   501  50000  1.5    05:00 /usr/local/bin/node /opt/agentproto/daemon.js
 200   100   501 800000 12.3    00:59 /Applications/Visual Studio Code.app/Contents/MacOS/Electron --type=renderer
 300   100   501   4096  0.0    01:02:03 /usr/bin/git status
garbage line that is not a row
`

const LINUX_PS = `
    1     0     0   9000  0.0 12-03:04:05 /sbin/init
    2     0     0      0  0.0 12-03:04:05 [kthreadd]
  100     1  1000  50000  1,5       05:00 node /opt/agentproto/daemon.js
  200   100  1000 800000 12.3    00:59 node /repo/node_modules/vitest/dist/workers/forks.js
`

describe("parseEtime", () => {
  it("parses mm:ss, hh:mm:ss and dd-hh:mm:ss", () => {
    expect(parseEtime("00:59")).toBe(59)
    expect(parseEtime("05:00")).toBe(300)
    expect(parseEtime("01:02:03")).toBe(3723)
    expect(parseEtime("12-03:04:05")).toBe(12 * 86400 + 3 * 3600 + 4 * 60 + 5)
  })
  it("returns 0 for garbage", () => {
    expect(parseEtime("soon")).toBe(0)
    expect(parseEtime("")).toBe(0)
  })
})

describe("psArgs", () => {
  it("uses command= on macOS and args= on Linux", () => {
    expect(psArgs("darwin").at(-1)).toBe("pid=,ppid=,uid=,rss=,pcpu=,etime=,command=")
    expect(psArgs("linux").at(-1)).toBe("pid=,ppid=,uid=,rss=,pcpu=,etime=,args=")
  })
})

describe("parsePsTable", () => {
  it("parses macOS rows including paths with spaces and skips torn lines", () => {
    const rows = parsePsTable(MACOS_PS, "darwin")
    expect(rows.map(r => r.pid)).toEqual([1, 100, 200, 300])
    const app = rows.find(r => r.pid === 200)!
    expect(app).toMatchObject({ ppid: 100, uid: 501, rssKib: 800000, cpuPercent: 12.3, elapsedSec: 59 })
    expect(app.args).toBe("/Applications/Visual Studio Code.app/Contents/MacOS/Electron --type=renderer")
    expect(rows.find(r => r.pid === 1)!.elapsedSec).toBe(12 * 86400 + 3 * 3600 + 4 * 60 + 5)
  })

  it("drops Linux kernel threads and accepts a comma decimal", () => {
    const rows = parsePsTable(LINUX_PS, "linux")
    expect(rows.map(r => r.pid)).toEqual([1, 100, 200])
    expect(rows.find(r => r.pid === 100)!.cpuPercent).toBe(1.5)
  })
})

describe("parseProcStat", () => {
  const ctx = { uptimeSec: 1000, clkTck: 100, pageSize: 4096 }
  // fields after `)`: state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice threads itrealvalue starttime vsize rss
  const tail = "S 42 1 1 0 -1 0 0 0 0 0 500 300 0 0 20 0 1 0 90000 1000000 250"

  it("derives rss, cpu and elapsed from a stat line", () => {
    const row = parseProcStat(`77 (node) ${tail}`, "node\0/app/server.js\0", 1000, ctx)!
    expect(row).toMatchObject({ pid: 77, ppid: 42, uid: 1000, rssKib: 1000, args: "node /app/server.js" })
    // started at 900s of a 1000s uptime → 100s elapsed; 8s cpu → 8%
    expect(row.elapsedSec).toBe(100)
    expect(row.cpuPercent).toBe(8)
  })

  it("survives a comm with spaces and parens", () => {
    const row = parseProcStat(`78 (my (weird) proc) ${tail}`, "", 0, ctx)!
    expect(row.pid).toBe(78)
    expect(row.ppid).toBe(42)
    expect(row.args).toBe("[my (weird) proc]")
  })

  it("returns null for a torn line", () => {
    expect(parseProcStat("79 (x) S 1", "", 0, ctx)).toBeNull()
    expect(parseProcStat("no parens", "", 0, ctx)).toBeNull()
  })
})

describe("normalizeCommand", () => {
  const cases: Array<[string, string]> = [
    ["node /home/u/.local/share/pnpm/pnpm.cjs install --frozen-lockfile", "pnpm install"],
    ["/usr/local/bin/pnpm run build", "pnpm run build"],
    ["pnpm --filter x test", "pnpm test"],
    ["node /repo/node_modules/vitest/dist/workers/forks.js", "vitest"],
    ["node /repo/node_modules/.bin/vitest run", "vitest"],
    ["node /repo/node_modules/typescript/lib/tsc.js --noEmit", "tsc"],
    ["node /repo/node_modules/tsup/dist/cli-default.js", "tsup"],
    ["/repo/node_modules/@esbuild/darwin-arm64/bin/esbuild --service=0.21.0 --ping", "esbuild"],
    ["node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume", "claude"],
    ["/usr/bin/git status --porcelain", "git"],
    ["node -e console.log(1)", "node"],
    ["node --import tsx /app/custom-script.mjs", "node"],
    ["/Applications/Visual Studio Code.app/Contents/MacOS/Electron --type=gpu", "Visual Studio Code"],
    ["/bin/zsh -l", "zsh"],
    ["", "?"],
  ]
  for (const [raw, want] of cases) {
    it(`${raw || "(empty)"} -> ${want}`, () => {
      expect(normalizeCommand(raw)).toBe(want)
    })
  }
})

describe("host parsers", () => {
  it("reads MemAvailable from /proc/meminfo", () => {
    expect(parseMeminfoAvailable("MemTotal: 100 kB\nMemAvailable:   2048 kB\n")).toBe(2048 * 1024)
    expect(parseMeminfoAvailable("MemTotal: 100 kB\n")).toBeUndefined()
  })

  it("sums free, inactive, speculative and purgeable pages from vm_stat", () => {
    const out = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                               10.",
      "Pages active:                            999.",
      "Pages inactive:                           20.",
      "Pages speculative:                         5.",
      "Pages purgeable:                           1.",
    ].join("\n")
    expect(parseVmStatAvailable(out)).toBe(36 * 16384)
    expect(parseVmStatAvailable("nope")).toBeUndefined()
  })
})

// ── attribution ─────────────────────────────────────────────────────

const NOW = 1_800_000_000_000
const row = (pid: number, ppid: number, args: string, over: Partial<ProcRow> = {}): ProcRow => ({
  pid,
  ppid,
  uid: 501,
  rssKib: 1000,
  cpuPercent: 1,
  elapsedSec: 600,
  args,
  ...over,
})

const HOST: HostInfo = {
  platform: "darwin",
  cpuCount: 8,
  loadAvg: [1, 2, 3],
  totalMemBytes: 16 * 1024 ** 3,
  freeMemBytes: 4 * 1024 ** 3,
}

describe("attributeProcesses", () => {
  const base = { daemonPid: 10, provisions: [], detail: "summary" as const, nowMs: NOW, uid: 501 }

  it("descends from each live session's adapter pid and sums rss/cpu/procs", () => {
    const table = [
      row(10, 1, "node daemon.js", { rssKib: 5000 }),
      row(20, 10, "claude", { rssKib: 3000, cpuPercent: 2 }),
      row(21, 20, "node /r/node_modules/vitest/dist/workers/forks.js", { rssKib: 9000, cpuPercent: 40 }),
      row(22, 20, "/usr/bin/git status", { rssKib: 500 }),
      row(30, 10, "claude", { rssKib: 1000 }),
    ]
    const r = attributeProcesses({
      ...base,
      table,
      sessions: [
        { id: "a", pid: 20, live: true },
        { id: "b", pid: 30, live: true },
      ],
    })
    const a = r.sessions.find(s => s.sessionId === "a")!
    expect(a.procCount).toBe(3)
    expect(a.rssBytes).toBe(12500 * 1024)
    expect(a.cpuPercent).toBe(43)
    expect(a.topCommands[0]).toMatchObject({ name: "vitest", count: 1, rssBytes: 9000 * 1024 })
    expect(r.sessions[0]!.sessionId).toBe("a") // sorted by RAM
    expect(r.daemon).toMatchObject({ pid: 10, procCount: 1, rssBytes: 5000 * 1024 })
    expect(r.orphans).toEqual([])
  })

  it("keeps a nested session's subtree out of its parent session", () => {
    const table = [
      row(10, 1, "node daemon.js"),
      row(20, 10, "claude"),
      row(21, 20, "claude"),
      row(22, 21, "git log"),
    ]
    const r = attributeProcesses({
      ...base,
      table,
      sessions: [
        { id: "outer", pid: 20, live: true },
        { id: "inner", pid: 21, live: true },
      ],
    })
    expect(r.sessions.find(s => s.sessionId === "outer")!.procCount).toBe(1)
    expect(r.sessions.find(s => s.sessionId === "inner")!.procCount).toBe(2)
  })

  it("ignores sessions with no pid or a pid that is not in the table", () => {
    const r = attributeProcesses({
      ...base,
      table: [row(10, 1, "node daemon.js")],
      sessions: [
        { id: "nopid", pid: null, live: true },
        { id: "gone", pid: 999, live: true },
      ],
    })
    expect(r.sessions).toEqual([])
  })

  it("excludes the sampler's own ps invocation", () => {
    const r = attributeProcesses({
      ...base,
      table: [
        row(10, 1, "node daemon.js"),
        row(11, 10, "ps -A -ww -o pid=,ppid=,uid=,rss=,pcpu=,etime=,command="),
      ],
      sessions: [],
    })
    expect(r.daemon.procCount).toBe(1)
  })

  it("buckets daemon children started after an in-flight provision as provisioning", () => {
    const startedAt = new Date(NOW - 30_000).toISOString()
    const table = [
      row(10, 1, "node daemon.js"),
      row(40, 10, "node /x/pnpm.cjs install", { elapsedSec: 20, rssKib: 7000 }),
      row(41, 40, "node /r/node_modules/tsup/dist/cli-default.js", { elapsedSec: 10, rssKib: 3000 }),
      row(50, 10, "/usr/bin/caffeinate", { elapsedSec: 4000 }), // older than the provision: daemon's own
    ]
    const r = attributeProcesses({
      ...base,
      table,
      sessions: [],
      provisions: [{ cwd: "/wt", startedAt }],
    })
    expect(r.provisioning.procCount).toBe(2)
    expect(r.provisioning.rssBytes).toBe(10000 * 1024)
    expect(r.provisioning.topCommands.map(c => c.name)).toEqual(["pnpm install", "tsup"])
    expect(r.daemon.procCount).toBe(2)
  })

  it("puts nothing in provisioning when no provision is in flight", () => {
    const r = attributeProcesses({
      ...base,
      table: [row(10, 1, "node daemon.js"), row(40, 10, "node /x/pnpm.cjs install", { elapsedSec: 2 })],
      sessions: [],
    })
    expect(r.provisioning.procCount).toBe(0)
    expect(r.daemon.procCount).toBe(2)
  })

  it("reports a reparented process with an adapter-config marker as an orphan, whole subtree", () => {
    const table = [
      row(10, 1, "node daemon.js"),
      row(70, 1, "node /home/u/.agentproto/adapter-config/sess_dead/mcp.js", { rssKib: 2000, elapsedSec: 9000 }),
      row(71, 70, "/usr/bin/git fetch", { rssKib: 1000 }),
      row(80, 1, "/usr/bin/vim notes.txt"), // unrelated stray: not reported
    ]
    const r = attributeProcesses({ ...base, table, sessions: [{ id: "sess_dead", pid: 5, live: false }] })
    expect(r.orphans).toHaveLength(1)
    expect(r.orphans[0]).toMatchObject({
      pid: 70,
      sessionHint: "sess_dead",
      procCount: 2,
      rssBytes: 3000 * 1024,
      elapsedSec: 9000,
    })
    expect(r.orphans[0]!.reason).toMatch(/adapter-config/)
  })

  it("uses env hints for strays with no marker in their args", () => {
    const table = [row(10, 1, "node daemon.js"), row(90, 1, "node server.js")]
    const r = attributeProcesses({
      ...base,
      table,
      sessions: [],
      envHints: new Map([[90, "sess_env"]]),
    })
    expect(r.orphans).toHaveLength(1)
    expect(r.orphans[0]).toMatchObject({ pid: 90, sessionHint: "sess_env", reason: "session env marker" })
  })

  it("matches an ended session's known directory in args", () => {
    const table = [row(10, 1, "node daemon.js"), row(95, 1, "node /wt/feature/node_modules/vitest/vitest.mjs")]
    const r = attributeProcesses({
      ...base,
      table,
      sessions: [{ id: "sess_old", live: false, markerPaths: ["/wt/feature"] }],
    })
    expect(r.orphans).toHaveLength(1)
    expect(r.orphans[0]).toMatchObject({ pid: 95, sessionHint: "sess_old", command: "vitest" })
  })

  it("merges a stray marked for a LIVE session into that session as detached", () => {
    const table = [
      row(10, 1, "node daemon.js"),
      row(20, 10, "claude", { rssKib: 1000 }),
      row(60, 1, "node srv.js --cfg /h/.agentproto/adapter-config/sess_live/x", { rssKib: 4000 }),
    ]
    const r = attributeProcesses({
      ...base,
      detail: "full",
      table,
      sessions: [{ id: "sess_live", pid: 20, live: true }],
    })
    expect(r.orphans).toEqual([])
    const s = r.sessions[0]!
    expect(s.procCount).toBe(2)
    expect(s.rssBytes).toBe(5000 * 1024)
    expect(s.processes!.find(p => p.pid === 60)!.detached).toBe(true)
    expect(s.processes!.find(p => p.pid === 20)!.detached).toBeUndefined()
  })

  it("does not swallow an unmarked parent into an orphan group", () => {
    const table = [
      row(10, 1, "node daemon.js"),
      row(50, 1, "/usr/bin/some-other-daemon", { rssKib: 90000 }),
      row(51, 50, "node /h/.agentproto/adapter-config/sess_dead/x.js", { rssKib: 2000 }),
      row(52, 51, "git fetch", { rssKib: 100 }),
    ]
    const r = attributeProcesses({ ...base, table, sessions: [] })
    expect(r.orphans).toHaveLength(1)
    expect(r.orphans[0]).toMatchObject({ pid: 51, procCount: 2, rssBytes: 2100 * 1024 })
  })

  it("ignores macOS zombies and the daemon's own vm_stat probe", () => {
    const table = [
      row(10, 1, "node daemon.js"),
      row(11, 10, "(node)", { rssKib: 0 }),
      row(12, 10, "/usr/bin/vm_stat", { rssKib: 300 }),
    ]
    const r = attributeProcesses({ ...base, table, sessions: [] })
    expect(r.daemon.procCount).toBe(1)
    expect(r.daemon.topCommands.map(c => c.name)).toEqual(["node"])
  })

  it("does not flag another user's processes", () => {
    const table = [
      row(10, 1, "node daemon.js"),
      row(70, 1, "node /home/u/.agentproto/adapter-config/sess_dead/mcp.js", { uid: 0 }),
    ]
    const r = attributeProcesses({ ...base, table, sessions: [] })
    expect(r.orphans).toEqual([])
  })

  it("only includes per-process detail in full mode, largest first", () => {
    const table = [row(10, 1, "node daemon.js"), row(20, 10, "claude", { rssKib: 1 }), row(21, 20, "git", { rssKib: 9 })]
    const sessions = [{ id: "a", pid: 20, live: true }]
    const summary = attributeProcesses({ ...base, table, sessions })
    expect(summary.sessions[0]!.processes).toBeUndefined()
    const full = attributeProcesses({ ...base, table, sessions, detail: "full" })
    expect(full.sessions[0]!.processes!.map(p => [p.pid, p.command])).toEqual([
      [21, "git"],
      [20, "claude"],
    ])
  })
})

// ── tracker ─────────────────────────────────────────────────────────

describe("provision tracker", () => {
  it("lists in-flight provisions and clears them on completion and on failure", async () => {
    const tracker = createProvisionTracker(() => NOW)
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    const p = trackWorktreeProvision({ sessionId: "s1", label: "lbl", cwd: "/wt" }, () => gate, tracker)
    expect(tracker.list()).toEqual([
      { sessionId: "s1", label: "lbl", cwd: "/wt", startedAt: new Date(NOW).toISOString() },
    ])
    release()
    await p
    expect(tracker.list()).toEqual([])

    await expect(
      trackWorktreeProvision({ cwd: "/wt2" }, async () => Promise.reject(new Error("boom")), tracker),
    ).rejects.toThrow("boom")
    expect(tracker.list()).toEqual([])
  })
})

// ── service ─────────────────────────────────────────────────────────

describe("createProcessStatsService", () => {
  const table = [row(10, 1, "node daemon.js"), row(20, 10, "claude"), row(21, 20, "git")]
  const sessions: StatsSessionDescriptor[] = [{ id: "a", pid: 20, status: "running", label: "alpha" }]

  function service(over: { now?: () => number; ttlMs?: number } = {}) {
    const tableSource = vi.fn(async () => table)
    const svc = createProcessStatsService({
      table: tableSource,
      host: async () => HOST,
      envHints: async () => new Map(),
      tracker: createProvisionTracker(),
      daemonPid: 10,
      uid: 501,
      now: over.now ?? (() => NOW),
      ...(over.ttlMs !== undefined ? { ttlMs: over.ttlMs } : {}),
    })
    return { svc, tableSource }
  }

  it("builds a report with host, sessions, daemon, and totals", async () => {
    const { svc } = service()
    const r = await svc.report(sessions)
    expect(r.host).toEqual(HOST)
    expect(r.sessions).toHaveLength(1)
    expect(r.sessions[0]).toMatchObject({ sessionId: "a", pid: 20, procCount: 2 })
    expect(r.totals.procCount).toBe(3)
    expect(r.totals.rssBytes).toBe(3000 * 1024)
    expect(r.sampledAt).toBe(new Date(NOW).toISOString())
  })

  it("reads the process table once within the TTL, even for concurrent callers", async () => {
    const { svc, tableSource } = service()
    await Promise.all([svc.report(sessions), svc.report(sessions), svc.report(sessions, { detail: "full" })])
    await svc.report(sessions)
    expect(tableSource).toHaveBeenCalledTimes(1)
  })

  it("resamples after the TTL and when fresh is requested", async () => {
    let t = NOW
    const { svc, tableSource } = service({ now: () => t, ttlMs: 3000 })
    await svc.report(sessions)
    t += 3500
    await svc.report(sessions)
    expect(tableSource).toHaveBeenCalledTimes(2)
    await svc.report(sessions, { fresh: true })
    expect(tableSource).toHaveBeenCalledTimes(3)
  })

  it("reads env only for unclaimed reparented roots, once per process", async () => {
    const readEnv = vi.fn(async (pids: readonly number[]) => new Map(pids.map(p => [p, "sess_x"] as const)))
    let t = NOW
    const svc = createProcessStatsService({
      table: async () => [...table, row(90, 1, "node server.js", { elapsedSec: 600 + (t - NOW) / 1000 })],
      host: async () => HOST,
      envHints: readEnv,
      tracker: createProvisionTracker(),
      daemonPid: 10,
      uid: 501,
      now: () => t,
    })
    const r = await svc.report(sessions)
    expect(readEnv).toHaveBeenCalledTimes(1)
    expect(readEnv.mock.calls[0]![0]).toEqual([90])
    expect(r.orphans.map(o => o.pid)).toEqual([90])
    t += 10_000
    await svc.report(sessions)
    expect(readEnv.mock.calls[1]![0]).toEqual([]) // memoized
  })

  it("marks in-flight provisions on the report", async () => {
    const tracker = createProvisionTracker(() => NOW)
    const svc = createProcessStatsService({
      table: async () => table,
      host: async () => HOST,
      envHints: async () => new Map(),
      tracker,
      daemonPid: 10,
      uid: 501,
      now: () => NOW,
    })
    const end = tracker.begin({ label: "wt", cwd: "/wt" })
    const r = await svc.report(sessions)
    expect(r.provisioning.inFlight).toHaveLength(1)
    end()
  })
})

describe("surface helpers", () => {
  const sessions: StatsSessionDescriptor[] = [
    { id: "a", pid: 20, status: "running", label: "alpha", kind: "agent-cli", adapterSlug: "claude" },
    { id: "b", pid: 30, status: "running", label: "beta", kind: "agent-cli" },
    { id: "c", pid: null, status: "ended" },
  ]
  const table = [
    row(10, 1, "node daemon.js", { rssKib: 100 }),
    row(20, 10, "claude", { rssKib: 200 }),
    row(30, 10, "claude", { rssKib: 300 }),
  ]
  const svc = () =>
    createProcessStatsService({
      table: async () => table,
      host: async () => HOST,
      envHints: async () => new Map(),
      tracker: createProvisionTracker(),
      daemonPid: 10,
      uid: 501,
      now: () => NOW,
    })

  it("statsDetailOf maps the request param", () => {
    expect(statsDetailOf(true)).toBe("summary")
    expect(statsDetailOf("full")).toBe("full")
    expect(statsDetailOf(false)).toBeUndefined()
    expect(statsDetailOf(undefined)).toBeUndefined()
  })

  it("withSessionStats stamps measured rows and leaves the rest without stats", async () => {
    const rows = await withSessionStats(sessions, sessions, "summary", svc())
    expect(rows[0]!.stats).toMatchObject({ pid: 20, rssBytes: 200 * 1024, procCount: 1 })
    expect(rows[0]!.stats).not.toHaveProperty("sessionId")
    expect(rows[1]!.stats).toBeDefined()
    expect(rows[2]).not.toHaveProperty("stats")
  })

  it("withSessionStats returns rows untouched when sampling fails", async () => {
    const broken = { report: async () => Promise.reject(new Error("no ps")) }
    const rows = await withSessionStats(sessions, sessions, "summary", broken)
    expect(rows).toEqual(sessions)
  })

  it("buildLabeledStatsReport labels rows from the registry", async () => {
    const r = await buildLabeledStatsReport({ sessions, service: svc() })
    expect(r.scoped).toBeUndefined()
    expect(r.sessions.map(s => [s.sessionId, s.label, s.status])).toEqual([
      ["b", "beta", "running"],
      ["a", "alpha", "running"],
    ])
    expect(r.sessions[1]!.adapterSlug).toBe("claude")
    expect(r.daemon.procCount).toBe(1)
  })

  it("scopes a subtree caller to its own sessions and withholds host-wide buckets", async () => {
    const r = await buildLabeledStatsReport({ sessions, visible: new Set(["a"]), service: svc() })
    expect(r.scoped).toBe(true)
    expect(r.sessions.map(s => s.sessionId)).toEqual(["a"])
    expect(r.daemon).toMatchObject({ pid: 10, rssBytes: 0, procCount: 0 })
    expect(r.provisioning.procCount).toBe(0)
    expect(r.orphans).toEqual([])
    expect(r.totals).toEqual({ rssBytes: 200 * 1024, cpuPercent: 1, procCount: 1 })
  })
})
