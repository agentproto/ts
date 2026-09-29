/**
 * `agentproto sessions --stats[=full]`: flag parsing, the pure table
 * renderer (snapshot-style, colour off), and the command wired to a fake
 * daemon (same `_daemon-helpers` mock as sessions-json-fields.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { LabeledProcessStatsReport, SessionDescriptor } from "@agentproto/runtime"
import { runSessions } from "../commands/sessions.js"
import {
  StatsFlagError,
  extractStatsFlag,
  formatBytes,
  formatElapsed,
  renderStatsTable,
} from "../commands/sessions-stats.js"

vi.mock("../commands/_daemon-helpers.js", async importOriginal => {
  const orig = await importOriginal<typeof import("../commands/_daemon-helpers.js")>()
  return {
    ...orig,
    discoverDaemon: vi.fn(),
    httpGetJson: vi.fn(),
    printNoDaemonError: vi.fn(),
  }
})

const helpers = await import("../commands/_daemon-helpers.js")
const discoverDaemon = vi.mocked(helpers.discoverDaemon)
const httpGetJson = vi.mocked(helpers.httpGetJson)

const MB = 1024 * 1024

const REPORT: LabeledProcessStatsReport = {
  sampledAt: "2026-09-28T12:00:00.000Z",
  detail: "summary",
  host: {
    platform: "darwin",
    cpuCount: 12,
    loadAvg: [3.25, 2.5, 1.75],
    totalMemBytes: 64 * 1024 * MB,
    freeMemBytes: 20 * 1024 * MB,
  },
  sessions: [
    {
      sessionId: "sess_small",
      pid: 300,
      label: "docs",
      kind: "agent-cli",
      status: "running",
      rssBytes: 300 * MB,
      cpuPercent: 0.5,
      procCount: 2,
      topCommands: [{ name: "claude", count: 1, rssBytes: 280 * MB, cpuPercent: 0.4 }],
    },
    {
      sessionId: "sess_big",
      pid: 200,
      label: "gate-run",
      kind: "agent-cli",
      status: "running",
      rssBytes: 2048 * MB,
      cpuPercent: 84.2,
      procCount: 9,
      topCommands: [
        { name: "vitest", count: 4, rssBytes: 1500 * MB, cpuPercent: 80 },
        { name: "claude", count: 1, rssBytes: 400 * MB, cpuPercent: 1 },
      ],
      processes: [
        { pid: 201, ppid: 200, command: "vitest", args: "node vitest", rssBytes: 900 * MB, cpuPercent: 40, elapsedSec: 45 },
        { pid: 200, ppid: 100, command: "claude", args: "claude", rssBytes: 400 * MB, cpuPercent: 1, elapsedSec: 7300 },
      ],
    },
  ],
  daemon: {
    pid: 100,
    rssBytes: 150 * MB,
    cpuPercent: 1.2,
    procCount: 1,
    topCommands: [{ name: "node", count: 1, rssBytes: 150 * MB, cpuPercent: 1.2 }],
  },
  provisioning: {
    rssBytes: 0,
    cpuPercent: 0,
    procCount: 0,
    topCommands: [],
    inFlight: [],
  },
  orphans: [
    {
      pid: 777,
      command: "vitest",
      rssBytes: 512 * MB,
      cpuPercent: 0,
      procCount: 3,
      elapsedSec: 90000,
      sessionHint: "sess_dead",
      reason: "adapter-config marker in command line",
      topCommands: [],
    },
  ],
  totals: { rssBytes: 2498 * MB, cpuPercent: 85.9, procCount: 12 },
}

const ROWS = [
  { id: "sess_small", label: "docs", kind: "agent-cli", status: "running" },
  { id: "sess_big", label: "gate-run", kind: "agent-cli", status: "running" },
  { id: "sess_idle", label: "", kind: "terminal", status: "ended" },
]

describe("extractStatsFlag", () => {
  it("returns the args untouched when --stats is absent", () => {
    expect(extractStatsFlag(["--json", "-v"])).toEqual({ rest: ["--json", "-v"], stats: undefined })
    expect(extractStatsFlag(["--verbose"]).stats).toBeUndefined()
  })
  it("parses --stats and --stats=full", () => {
    expect(extractStatsFlag(["--stats"])).toEqual({ rest: [], stats: "summary" })
    expect(extractStatsFlag(["--json", "--stats=full"])).toEqual({ rest: ["--json"], stats: "full" })
    expect(extractStatsFlag(["--stats=true"]).stats).toBe("summary")
  })
  it("treats --stats --verbose as full", () => {
    expect(extractStatsFlag(["--stats", "--verbose"]).stats).toBe("full")
    expect(extractStatsFlag(["-v", "--stats"]).stats).toBe("full")
  })
  it("rejects an unknown value", () => {
    expect(() => extractStatsFlag(["--stats=lots"])).toThrow(StatsFlagError)
  })
})

describe("formatters", () => {
  it("formats bytes and elapsed compactly", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(1536)).toBe("1.5 KB")
    expect(formatBytes(300 * MB)).toBe("300 MB")
    expect(formatBytes(2048 * MB)).toBe("2.0 GB")
    expect(formatElapsed(45)).toBe("45s")
    expect(formatElapsed(7300)).toBe("2h")
    expect(formatElapsed(90000)).toBe("1d")
  })
})

/** Rendered text, one entry per line, trailing padding removed. */
const lines = (out: string): string[] => out.replace(/\n$/, "").split("\n").map(l => l.trimEnd())

describe("renderStatsTable", () => {
  it("summary output", () => {
    const out = renderStatsTable(ROWS, REPORT, { colour: false, mode: "summary" })
    expect(lines(out)).toEqual([
      "host: load 3.25 2.50 1.75 (12 cpus) | memory free 20.0 GB of 64.0 GB",
      "",
      "ID          LABEL                               KIND       STATUS      RAM    CPU  PROCS  TOP",
      "sess_big    gate-run                            agent-cli  running  2.0 GB  84.2%      9  vitest x4 1.5 GB, claude 400 MB",
      "sess_small  docs                                agent-cli  running  300 MB   0.5%      2  claude 280 MB",
      "sess_idle   -                                   terminal   ended         -      -      -",
      "----------------------------------------------------------------------------------------------------",
      "-           (daemon pid 100)                    daemon              150 MB   1.2%      1  node 150 MB",
      "-           (worktree provisioning)             provision              0 B   0.0%      0",
      "TOTAL       (sessions + daemon + provisioning)                      2.4 GB  85.9%     12",
      "",
      "orphans: 1 agentproto-looking process group(s) with no live session (reported only, never killed)",
      "PID  COMMAND     RAM   CPU  PROCS  AGE  SESSION    WHY",
      "777  vitest   512 MB  0.0%      3   1d  sess_dead  adapter-config marker in command line",
      "",
      "sampled 2026-09-28T12:00:00.000Z; CPU is ps's %CPU (kernel-averaged, lags spikes); cached ~3s",
    ])
  })

  it("full output adds a per-process breakdown", () => {
    const out = renderStatsTable(ROWS, { ...REPORT, detail: "full" }, { colour: false, mode: "full" })
    expect(lines(out)).toEqual([
      "host: load 3.25 2.50 1.75 (12 cpus) | memory free 20.0 GB of 64.0 GB",
      "",
      "ID          LABEL                               KIND       STATUS      RAM    CPU  PROCS  TOP",
      "sess_big    gate-run                            agent-cli  running  2.0 GB  84.2%      9  vitest x4 1.5 GB, claude 400 MB",
      "      201  vitest     900 MB    40.0%   45s",
      "      200  claude     400 MB     1.0%    2h",
      "sess_small  docs                                agent-cli  running  300 MB   0.5%      2  claude 280 MB",
      "sess_idle   -                                   terminal   ended         -      -      -",
      "----------------------------------------------------------------------------------------------------",
      "-           (daemon pid 100)                    daemon              150 MB   1.2%      1  node 150 MB",
      "-           (worktree provisioning)             provision              0 B   0.0%      0",
      "TOTAL       (sessions + daemon + provisioning)                      2.4 GB  85.9%     12",
      "",
      "orphans: 1 agentproto-looking process group(s) with no live session (reported only, never killed)",
      "PID  COMMAND     RAM   CPU  PROCS  AGE  SESSION    WHY",
      "777  vitest   512 MB  0.0%      3   1d  sess_dead  adapter-config marker in command line",
      "",
      "sampled 2026-09-28T12:00:00.000Z; CPU is ps's %CPU (kernel-averaged, lags spikes); cached ~3s",
    ])
  })

  it("omits host-wide buckets and orphans for a scoped report", () => {
    const out = renderStatsTable(ROWS, { ...REPORT, scoped: true }, { colour: false, mode: "summary" })
    expect(out).not.toContain("(daemon")
    expect(out).not.toContain("orphans")
    expect(out).toContain("(your sessions)")
  })
})

describe("agentproto sessions --stats", () => {
  let out: string[]
  let err: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spies: any[]

  const sessions = ROWS.map(
    r =>
      ({
        id: r.id,
        kind: r.kind,
        workspaceSlug: "default",
        command: "x",
        status: r.status === "ended" ? "ended" : "running",
        startedAt: "2026-09-28T11:00:00.000Z",
        cwd: "/tmp",
        ...(r.label ? { label: r.label } : {}),
      }) as SessionDescriptor,
  )

  beforeEach(() => {
    out = []
    err = []
    spies = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(process.stdout as any, "write").mockImplementation((c: unknown) => (out.push(String(c)), true)),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(process.stderr as any, "write").mockImplementation((c: unknown) => (err.push(String(c)), true)),
    ]
    discoverDaemon.mockResolvedValue({ found: { url: "http://127.0.0.1:18790", token: "tok" }, stale: [] })
    httpGetJson.mockImplementation(async (url: string) => {
      if (url.includes("/sessions/stats")) return REPORT
      return { sessions }
    })
  })

  afterEach(() => {
    for (const s of spies) s.mockRestore()
    vi.restoreAllMocks()
  })

  it("prints the RAM-sorted table, requesting summary detail", async () => {
    const code = await runSessions(["--stats", "--no-color"])
    expect(code).toBe(0)
    expect(httpGetJson).toHaveBeenCalledWith("http://127.0.0.1:18790/sessions/stats?detail=summary")
    const text = out.join("")
    expect(text.indexOf("gate-run")).toBeLessThan(text.indexOf("docs"))
    expect(text).toContain("TOTAL")
    expect(text).toContain("host: load 3.25 2.50 1.75")
  })

  it("--stats=full requests full detail", async () => {
    await runSessions(["--stats=full", "--no-color"])
    expect(httpGetJson).toHaveBeenCalledWith("http://127.0.0.1:18790/sessions/stats?detail=full")
  })

  it("--stats --json prints the daemon's report as JSON", async () => {
    const code = await runSessions(["--stats", "--json"])
    expect(code).toBe(0)
    expect(JSON.parse(out.join(""))).toEqual(REPORT)
  })

  it("rejects --stats with --watch", async () => {
    const code = await runSessions(["--stats", "--watch"])
    expect(code).toBe(2)
    expect(err.join("")).toMatch(/--stats/)
  })

  it("explains a daemon without the route", async () => {
    httpGetJson.mockRejectedValue(new Error("HTTP 404"))
    const code = await runSessions(["--stats"])
    expect(code).toBe(1)
    expect(err.join("")).toMatch(/restart/)
  })

  it("does not blame the daemon version for other failures", async () => {
    httpGetJson.mockRejectedValue(new Error("HTTP 500: ps failed"))
    const code = await runSessions(["--stats"])
    expect(code).toBe(1)
    expect(err.join("")).toMatch(/ps failed/)
    expect(err.join("")).not.toMatch(/restart/)
  })
})
