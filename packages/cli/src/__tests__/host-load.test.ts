/**
 * `agentproto host load`: the pure renderer (colour off) and the command wired
 * to a fake daemon (same `_daemon-helpers` mock as sessions-stats.test.ts) and
 * to a fake in-process collector for the no-daemon fallback.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { HostLoadReport, HostProcess } from "@agentproto/runtime"
import { renderHostLoad, runHost, ownerText } from "../commands/host.js"

vi.mock("../commands/_daemon-helpers.js", async importOriginal => {
  const orig = await importOriginal<typeof import("../commands/_daemon-helpers.js")>()
  return {
    ...orig,
    discoverDaemon: vi.fn(),
    httpGetJson: vi.fn(),
    printNoDaemonError: vi.fn(),
  }
})

const localReport = vi.fn()
vi.mock("@agentproto/runtime", async importOriginal => {
  const orig = await importOriginal<typeof import("@agentproto/runtime")>()
  return { ...orig, getHostLoadService: () => ({ report: localReport }) }
})

const helpers = await import("../commands/_daemon-helpers.js")
const discoverDaemon = vi.mocked(helpers.discoverDaemon)
const httpGetJson = vi.mocked(helpers.httpGetJson)

const MB = 1024 * 1024
const GB = 1024 * MB

const proc = (over: Partial<HostProcess> & { pid: number }): HostProcess => ({
  ppid: 1,
  uid: 501,
  command: "node",
  args: "node x.js",
  rssBytes: 100 * MB,
  memoryBytes: 100 * MB,
  memorySource: "rss",
  cpuPercent: 0,
  elapsedSec: 30,
  owner: { kind: "other" },
  ...over,
})

const HOG = proc({
  pid: 300,
  command: "node",
  args: "node -e mkdirSync",
  memoryBytes: 6 * GB,
  memorySource: "footprint",
  compressedBytes: 2 * GB,
  cpuPercent: 95,
  elapsedSec: 2580,
  owner: { kind: "orphan" },
  cwdDeleted: true,
})
const VITEST = proc({
  pid: 21,
  command: "vitest",
  cpuPercent: 40,
  elapsedSec: 120,
  owner: { kind: "session", sessionId: "sess_a", label: "builder" },
})

const REPORT: HostLoadReport = {
  sampledAt: "2026-09-29T12:00:00.000Z",
  detail: "summary",
  elapsedMs: 1234,
  partial: [],
  platform: "darwin",
  loadAvg: [663.54, 575.42, 593.73],
  cpuCount: 12,
  loadPerCore: 55.3,
  cpu: { userPercent: 50, sysPercent: 50, idlePercent: 0, source: "iostat" },
  memory: {
    totalBytes: 32 * GB,
    usedBytes: 28 * GB,
    wiredBytes: 5.5 * GB,
    compressorBytes: 12 * GB,
    cachedBytes: 4 * GB,
    freeBytes: 80 * MB,
    availableBytes: 7 * GB,
  },
  swap: { totalBytes: 16 * GB, usedBytes: 14.68 * GB, freeBytes: 1.32 * GB, percent: 91.8 },
  disks: [
    { name: "disk0", tps: 1503, mbPerSec: 31.41, kbPerTransfer: 21.41 },
    { name: "disk6", tps: 3500, mbPerSec: 15.54, kbPerTransfer: 4.5 },
  ],
  topByCpu: [HOG, VITEST],
  topByMemory: [HOG, VITEST],
  warnings: [
    { kind: "load", severity: "critical", message: "load 663.5 is 55x the 12 cores (limit 4x)" },
    { kind: "orphan", severity: "warn", message: "orphan (ppid 1) pid 300 node running 43m", pids: [300] },
  ],
}

describe("ownerText", () => {
  it("names sessions, orphans and the plain kinds", () => {
    expect(ownerText({ kind: "session", sessionId: "sess_a", label: "builder" })).toBe("sess_a (builder)")
    expect(ownerText({ kind: "session", sessionId: "sess_a" })).toBe("sess_a")
    expect(ownerText({ kind: "orphan" })).toBe("orphan")
    expect(ownerText({ kind: "orphan", sessionHint: "sess_dead" })).toBe("orphan (sess_dead)")
    expect(ownerText({ kind: "system" })).toBe("system")
    expect(ownerText({ kind: "daemon" })).toBe("daemon")
  })
})

describe("renderHostLoad", () => {
  const lines = (r: HostLoadReport, mode: "summary" | "full" = "summary", note?: string): string[] =>
    renderHostLoad(r, { colour: false, mode, ...(note ? { note } : {}) }).split("\n")

  it("renders the one-screen summary", () => {
    const out = lines(REPORT)
    expect(out[0]).toBe("host load  2026-09-29T12:00:00.000Z  (sampled in 1234 ms, darwin)")
    expect(out[1]).toBe("")
    expect(out[2]).toBe("load    663.54 575.42 593.73  (1m 5m 15m) on 12 cores = 55.3x per core")
    expect(out[3]).toBe("cpu     50.0% user  50.0% sys  0.0% idle  (iostat)")
    expect(out[4]).toBe(
      "memory  28.0 GB used of 32.0 GB   wired 5.5 GB   compressor 12.0 GB   cached 4.0 GB   free 80.0 MB   available 7.0 GB",
    )
    expect(out[5]).toBe("swap    14.7 GB of 16.0 GB used (92%)")
    expect(out[6]).toMatch(/^disks   disk0 +1503 tps +31\.4 MB\/s +21\.4 KB\/op$/)
    expect(out[7]).toMatch(/^        disk6 +3500 tps +15\.5 MB\/s +4\.5 KB\/op$/)
    expect(out[8]).toBe("")
    expect(out[9]).toBe("WARNINGS (2)")
    expect(out[10]).toBe("  [critical] load 663.5 is 55x the 12 cores (limit 4x)")
    expect(out[11]).toBe("  [warn]     orphan (ppid 1) pid 300 node running 43m")
    expect(out[13]).toBe("TOP BY CPU")
    expect(out[14]).toMatch(/^ {2}PID +COMMAND +MEM +CMPR +CPU +AGE +OWNER$/)
    expect(out[15]).toMatch(/^ {2}300 +node +6\.0 GB +2\.0 GB +95\.0% +43m +orphan$/)
    expect(out[16]).toMatch(/^ {2} 21 +vitest +100 MB\* +- +40\.0% +2m +sess_a \(builder\)$/)
    expect(out).toContain("TOP BY MEMORY  (footprint incl. compressed; * = RSS only)")
    expect(out.join("\n")).not.toContain("SESSIONS")
    expect(out.join("\n")).not.toContain("ALL PROCESSES")
  })

  it("says so when nothing is wrong and when probes are missing", () => {
    const quiet: HostLoadReport = {
      ...REPORT,
      warnings: [],
      partial: ["top: timed out after 1900ms"],
      disks: [],
      topByCpu: [],
      topByMemory: [],
    }
    delete quiet.swap
    delete quiet.cpu
    const text = lines(quiet, "summary", "no daemon found; sampled locally, no session attribution").join("\n")
    expect(text).toContain("no daemon found; sampled locally, no session attribution")
    expect(text).toContain("partial: top: timed out after 1900ms")
    expect(text).toContain("warnings: none")
    expect(text).toMatch(/swap +unavailable/)
    expect(text).toMatch(/cpu +unavailable/)
    expect(text).toMatch(/disks +unavailable/)
    expect(text).toContain("(none)")
  })

  it("adds the per-session rollup and every process in full mode", () => {
    const full: HostLoadReport = {
      ...REPORT,
      detail: "full",
      sessions: [
        { sessionId: "sess_a", label: "builder", rssBytes: 12 * MB, memoryBytes: 20 * MB, cpuPercent: 42, procCount: 2 },
      ],
      processes: [HOG, VITEST],
    }
    const text = lines(full, "full").join("\n")
    expect(text).toContain("SESSIONS")
    expect(text).toMatch(/sess_a +builder +20\.0 MB +12\.0 MB +42\.0% +2/)
    expect(text).toContain("ALL PROCESSES (2)")
  })

  it("marks scoped reports and colours only when asked", () => {
    expect(lines({ ...REPORT, scoped: true })[0]).toMatch(/\[scoped to your sessions\]$/)
    expect(renderHostLoad(REPORT, { colour: false, mode: "summary" })).not.toContain("\x1b[")
    expect(renderHostLoad(REPORT, { colour: true, mode: "summary" })).toContain("\x1b[31m[critical]")
  })
})

describe("runHost", () => {
  let out: string
  let err: string
  beforeEach(() => {
    out = ""
    err = ""
    vi.spyOn(process.stdout, "write").mockImplementation(((s: string | Uint8Array) => {
      out += String(s)
      return true
    }) as typeof process.stdout.write)
    vi.spyOn(process.stderr, "write").mockImplementation(((s: string | Uint8Array) => {
      err += String(s)
      return true
    }) as typeof process.stderr.write)
    discoverDaemon.mockReset()
    httpGetJson.mockReset()
    localReport.mockReset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const daemonUp = () =>
    discoverDaemon.mockResolvedValue({ found: { url: "http://127.0.0.1:9999", token: "tok" }, stale: [] })
  const daemonDown = () => discoverDaemon.mockResolvedValue({ found: null, stale: [] })

  it("prints usage and exits 2 with no args, 0 for --help", async () => {
    expect(await runHost([])).toBe(2)
    expect(out).toContain("agentproto host load")
    out = ""
    expect(await runHost(["--help"])).toBe(0)
    expect(out).toContain("--watch")
  })

  it("rejects an unknown subcommand, unknown flags and bad numbers with exit 2", async () => {
    expect(await runHost(["bogus"])).toBe(2)
    expect(err).toMatch(/unknown subcommand "bogus"/)
    expect(await runHost(["load", "--nope"])).toBe(2)
    expect(await runHost(["load", "--budget", "10"])).toBe(2)
    expect(err).toMatch(/--budget expects a number >= 300/)
    expect(await runHost(["load", "--watch", "0"])).toBe(2)
    expect(await runHost(["load", "extra"])).toBe(2)
    expect(httpGetJson).not.toHaveBeenCalled()
  })

  it("asks the daemon for the summary and renders it", async () => {
    daemonUp()
    httpGetJson.mockResolvedValue(REPORT)
    expect(await runHost(["load"])).toBe(0)
    expect(httpGetJson).toHaveBeenCalledWith("http://127.0.0.1:9999/host/load?detail=summary")
    expect(out).toContain("WARNINGS (2)")
    expect(err).toBe("")
  })

  it("passes --full, --fresh and --budget through as query params", async () => {
    daemonUp()
    httpGetJson.mockResolvedValue({ ...REPORT, detail: "full", sessions: [], processes: [] })
    expect(await runHost(["load", "--full", "--fresh", "--budget", "8000"])).toBe(0)
    const url = String(httpGetJson.mock.calls[0]![0])
    expect(new URL(url).searchParams.get("detail")).toBe("full")
    expect(new URL(url).searchParams.get("fresh")).toBe("true")
    expect(new URL(url).searchParams.get("budgetMs")).toBe("8000")
    expect(out).toContain("ALL PROCESSES (0)")
  })

  it("--json prints the report untouched", async () => {
    daemonUp()
    httpGetJson.mockResolvedValue(REPORT)
    expect(await runHost(["load", "--json"])).toBe(0)
    expect(JSON.parse(out)).toEqual(REPORT)
  })

  it("falls back to an in-process sample when no daemon is found", async () => {
    daemonDown()
    localReport.mockResolvedValue(REPORT)
    expect(await runHost(["load", "--budget", "5000"])).toBe(0)
    expect(httpGetJson).not.toHaveBeenCalled()
    expect(localReport).toHaveBeenCalledWith([], { detail: "summary", fresh: true, budgetMs: 5000 })
    expect(out).toContain("no daemon found; sampled locally, no session attribution")
  })

  it("falls back when the daemon errors, hinting at a stale daemon on 404", async () => {
    daemonUp()
    httpGetJson.mockRejectedValue(new Error("GET /host/load failed: 404"))
    localReport.mockResolvedValue(REPORT)
    expect(await runHost(["load"])).toBe(0)
    expect(out).toContain("it predates GET /host/load; restart it to pick the route up")
  })

  it("--local never contacts the daemon", async () => {
    localReport.mockResolvedValue(REPORT)
    expect(await runHost(["load", "--local", "--json"])).toBe(0)
    expect(discoverDaemon).not.toHaveBeenCalled()
    expect(JSON.parse(out).cpuCount).toBe(12)
  })

  it("returns 1 when even the local sample fails", async () => {
    daemonDown()
    localReport.mockRejectedValue(new Error("probe exploded"))
    expect(await runHost(["load"])).toBe(1)
    expect(err).toContain("probe exploded")
  })
})
