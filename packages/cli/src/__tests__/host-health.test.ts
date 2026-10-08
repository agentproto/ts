/**
 * `agentproto host health`: the pure verdict logic (every threshold boundary),
 * the pure renderer, and the command wired to a fake daemon.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { HostLoadReport, HostProcess } from "@agentproto/runtime"
import {
  DEFAULT_HEALTH_THRESHOLDS as D,
  computeHostHealth,
  renderHostHealth,
  resolveThresholds,
  type HostHealthInput,
} from "../commands/host-health.js"
import { countSessions, runHost } from "../commands/host.js"

vi.mock("../commands/_daemon-helpers.js", async importOriginal => {
  const orig = await importOriginal<typeof import("../commands/_daemon-helpers.js")>()
  return { ...orig, discoverDaemon: vi.fn(), httpGetJson: vi.fn(), printNoDaemonError: vi.fn() }
})

vi.mock("node:fs/promises", async importOriginal => {
  const orig = await importOriginal<typeof import("node:fs/promises")>()
  const statfs = async () => ({ bsize: 4096, bavail: (200 * 1024 ** 3) / 4096, blocks: (500 * 1024 ** 3) / 4096 })
  return { ...orig, statfs }
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

const orphan = (pid: number): HostProcess => ({
  pid,
  ppid: 1,
  uid: 501,
  command: "node",
  args: "node x.js",
  rssBytes: 10 * MB,
  memoryBytes: 10 * MB,
  memorySource: "rss",
  cpuPercent: 0,
  elapsedSec: 60,
  owner: { kind: "orphan" },
})

/** 10 cores, 100 GB RAM with 50 GB available, 10% swap: healthy. */
const HEALTHY: HostLoadReport = {
  sampledAt: "2026-10-01T08:00:00.000Z",
  detail: "full",
  elapsedMs: 900,
  partial: [],
  platform: "darwin",
  loadAvg: [5, 4, 3],
  cpuCount: 10,
  loadPerCore: 0.5,
  memory: { totalBytes: 100 * GB, freeBytes: GB, availableBytes: 50 * GB },
  swap: { totalBytes: 10 * GB, usedBytes: GB, freeBytes: 9 * GB, percent: 10 },
  disks: [],
  topByCpu: [],
  topByMemory: [],
  warnings: [],
  sessions: [],
  processes: [],
}

const UP = { reachable: true, uptimeMs: 3 * 86_400_000 }
const input = (over: Partial<HostHealthInput> = {}): HostHealthInput => ({
  report: HEALTHY,
  daemon: UP,
  sessions: { alive: 5, busy: 2 },
  disk: { path: "/home/me/.agentproto/sessions", freeBytes: 200 * GB, totalBytes: 500 * GB },
  ...over,
})
const withReport = (over: Partial<HostLoadReport>): HostHealthInput => input({ report: { ...HEALTHY, ...over } })
const check = (h: ReturnType<typeof computeHostHealth>, id: string) => h.checks.find(c => c.id === id)!

describe("computeHostHealth", () => {
  it("is OK with exit 0 and no reasons on a healthy host", () => {
    const h = computeHostHealth(input())
    expect(h.verdict).toBe("OK")
    expect(h.exitCode).toBe(0)
    expect(h.reasons).toEqual([])
    expect(h.checks.map(c => c.id)).toEqual([
      "load",
      "memory",
      "swap",
      "daemon",
      "sessions",
      "busy",
      "orphans",
      "busy-orphans",
      "disk",
    ])
    expect(h.checks.every(c => c.status === "OK")).toBe(true)
  })

  it("load: WARN at 2.0x per core, CRIT at 4.0x, just under stays lower", () => {
    const at = (l1: number) => check(computeHostHealth(withReport({ loadAvg: [l1, 0, 0] })), "load").status
    expect(at(19.99)).toBe("OK")
    expect(at(20)).toBe("WARN")
    expect(at(39.99)).toBe("WARN")
    expect(at(40)).toBe("CRIT")
  })

  it("ram: WARN below 15% available, CRIT below 5%", () => {
    const at = (avail: number) =>
      check(computeHostHealth(withReport({ memory: { ...HEALTHY.memory, availableBytes: avail * GB } })), "memory").status
    expect(at(15)).toBe("OK")
    expect(at(14.99)).toBe("WARN")
    expect(at(5)).toBe("WARN")
    expect(at(4.99)).toBe("CRIT")
  })

  it("swap: WARN at 50%, CRIT at 85%", () => {
    const at = (percent: number) =>
      check(computeHostHealth(withReport({ swap: { ...HEALTHY.swap!, percent } })), "swap").status
    expect(at(49.9)).toBe("OK")
    expect(at(50)).toBe("WARN")
    expect(at(84.9)).toBe("WARN")
    expect(at(85)).toBe("CRIT")
  })

  it("swap: SKIP without a swap probe, and SKIP never moves the verdict", () => {
    const { swap: _swap, ...noSwap } = HEALTHY
    const h = computeHostHealth(input({ report: noSwap }))
    expect(check(h, "swap").status).toBe("SKIP")
    expect(h.verdict).toBe("OK")
  })

  it("daemon: unreachable is CRIT, a daemon up under 60s is WARN, otherwise OK", () => {
    const at = (uptimeMs: number) => check(computeHostHealth(input({ daemon: { reachable: true, uptimeMs } })), "daemon")
    expect(at(60_000).status).toBe("OK")
    expect(at(59_999).status).toBe("WARN")
    expect(at(59_999).detail).toBe("daemon restarted 59s ago")
    const down = computeHostHealth(input({ daemon: { reachable: false, error: "connect ECONNREFUSED" } }))
    expect(check(down, "daemon").status).toBe("CRIT")
    expect(down.verdict).toBe("CRIT")
    expect(down.exitCode).toBe(2)
    expect(down.reasons).toEqual(["daemon unreachable (connect ECONNREFUSED)"])
  })

  it("daemon and sessions are SKIP with --local (no probe)", () => {
    const h = computeHostHealth(input({ daemon: undefined, sessions: undefined }))
    expect(["daemon", "sessions", "busy"].map(id => check(h, id).status)).toEqual(["SKIP", "SKIP", "SKIP"])
    expect(h.verdict).toBe("OK")
  })

  it("sessions: WARN at 30 live, CRIT at 60", () => {
    const at = (alive: number) => check(computeHostHealth(input({ sessions: { alive, busy: 0 } })), "sessions").status
    expect(at(29)).toBe("OK")
    expect(at(30)).toBe("WARN")
    expect(at(59)).toBe("WARN")
    expect(at(60)).toBe("CRIT")
  })

  it("busy: WARN at 8 mid-turn, CRIT at 16", () => {
    const at = (busy: number) => check(computeHostHealth(input({ sessions: { alive: busy, busy } })), "busy").status
    expect(at(7)).toBe("OK")
    expect(at(8)).toBe("WARN")
    expect(at(15)).toBe("WARN")
    expect(at(16)).toBe("CRIT")
  })

  it("orphans: counts owner=orphan processes, WARN at 10, CRIT at 30", () => {
    const at = (n: number) =>
      check(
        computeHostHealth(withReport({ processes: Array.from({ length: n }, (_, i) => orphan(i + 2)) })),
        "orphans",
      )
    expect(at(9).status).toBe("OK")
    expect(at(10).status).toBe("WARN")
    expect(at(29).status).toBe("WARN")
    expect(at(30).status).toBe("CRIT")
    expect(at(12).display).toBe("12")
  })

  it("orphans: without the full process list it counts the top lists and says 'at least'", () => {
    const { processes: _p, sessions: _s, ...summary } = HEALTHY
    const h = computeHostHealth(input({ report: { ...summary, topByCpu: [orphan(2), orphan(3)], topByMemory: [orphan(3), orphan(4)] } }))
    expect(check(h, "orphans").value).toBe(3)
    expect(check(h, "orphans").display).toBe(">=3")
  })

  it("busy orphans: the host_load orphan warnings, WARN at 1, CRIT at 5", () => {
    const warn = (n: number) =>
      check(
        computeHostHealth(
          withReport({
            warnings: [
              ...Array.from({ length: n }, (_, i) => ({ kind: "orphan" as const, severity: "warn" as const, message: `o${i}` })),
              { kind: "swap", severity: "warn", message: "ignored" },
            ],
          }),
        ),
        "busy-orphans",
      ).status
    expect(warn(0)).toBe("OK")
    expect(warn(1)).toBe("WARN")
    expect(warn(4)).toBe("WARN")
    expect(warn(5)).toBe("CRIT")
  })

  it("disk: WARN below 10 GB free, CRIT below 2 GB", () => {
    const at = (gb: number) =>
      check(computeHostHealth(input({ disk: { path: "/s", freeBytes: gb * GB, totalBytes: 500 * GB } })), "disk").status
    expect(at(10)).toBe("OK")
    expect(at(9.99)).toBe("WARN")
    expect(at(2)).toBe("WARN")
    expect(at(1.99)).toBe("CRIT")
    const bad = computeHostHealth(input({ disk: { path: "/s", error: "EACCES" } }))
    expect(check(bad, "disk").status).toBe("SKIP")
  })

  it("verdict is the worst check; reasons list CRIT before WARN", () => {
    const h = computeHostHealth(
      input({
        report: { ...HEALTHY, loadAvg: [25, 0, 0], swap: { ...HEALTHY.swap!, percent: 90 } },
      }),
    )
    expect(h.verdict).toBe("CRIT")
    expect(h.exitCode).toBe(2)
    expect(h.reasons).toEqual(["swap 1.0 GB of 10.0 GB used (90%)", "load 25.0 on 10 cores = 2.5x per core"])

    const warn = computeHostHealth(withReport({ loadAvg: [25, 0, 0] }))
    expect(warn.verdict).toBe("WARN")
    expect(warn.exitCode).toBe(1)
  })

  it("honours overridden thresholds", () => {
    const r = resolveThresholds({ "warn-load": "0.4", "crit-load": "0.6" })
    if ("error" in r) throw new Error(r.error)
    const h = computeHostHealth(input(), r.thresholds) // 0.5x per core
    expect(check(h, "load").status).toBe("WARN")
    expect(h.thresholds.critLoadPerCore).toBe(0.6)
    expect(D.critLoadPerCore).toBe(4)
  })
})

describe("resolveThresholds", () => {
  it("returns the defaults with no flags", () => {
    expect(resolveThresholds({})).toEqual({ thresholds: D })
  })
  it("rejects non-numeric / negative values and mis-ordered pairs", () => {
    expect(resolveThresholds({ "warn-load": "abc" })).toEqual({ error: '--warn-load expects a number >= 0, got "abc"' })
    expect(resolveThresholds({ "crit-disk": "-1" })).toHaveProperty("error")
    expect(resolveThresholds({ "warn-load": "5" })).toEqual({ error: "--warn-load (5) must be <= --crit-load (4)" })
    expect(resolveThresholds({ "warn-mem": "2" })).toHaveProperty("error") // below crit 5
    expect(resolveThresholds({ "warn-load": "5", "crit-load": "9" })).toHaveProperty("thresholds")
  })
})

describe("countSessions", () => {
  it("counts live agent-cli sessions and those mid-turn", () => {
    expect(
      countSessions([
        { kind: "agent-cli", status: "running", alive: true, busy: true },
        { kind: "agent-cli", status: "running", busy: false },
        { kind: "agent-cli", status: "starting" },
        { kind: "agent-cli", status: "exited", alive: false, busy: true },
        { kind: "terminal", status: "running", alive: true },
        { status: "running", busy: true },
      ]),
    ).toEqual({ alive: 4, busy: 2 })
  })
})

describe("renderHostHealth", () => {
  const render = (h: HostHealthInput, colour = false) => renderHostHealth(computeHostHealth(h), { colour })

  it("renders the verdict line, reasons and the check table", () => {
    expect(
      render(
        input({
          report: { ...HEALTHY, loadAvg: [25, 0, 0], processes: Array.from({ length: 11 }, (_, i) => orphan(i + 2)) },
          note: "sampled locally",
        }),
      ),
    ).toBe(
      [
        "WARN  load 25.0 on 10 cores = 2.5x per core; 11 orphan processes (ppid 1)",
        "sampled locally",
        "",
        "CHECK         STATUS  VALUE           WARN    CRIT",
        "load          WARN    2.50x per core  >=2x    >=4x",
        "ram           OK      50.0% avail     <15%    <5%",
        "swap          OK      10.0% used      >=50%   >=85%",
        "daemon        OK      up 3d           <60s    -",
        "sessions      OK      5 live          >=30    >=60",
        "busy          OK      2 busy          >=8     >=16",
        "orphans       WARN    11              >=10    >=30",
        "busy orphans  OK      0               >=1     >=5",
        "disk          OK      200 GB free     <10 GB  <2 GB",
        "",
      ].join("\n"),
    )
  })

  it("says there is headroom when OK, shows n/a for SKIP, and colours only when asked", () => {
    const plain = render(input({ daemon: undefined }))
    expect(plain.split("\n")[0]).toBe("OK  host has headroom for more agents")
    expect(plain).toMatch(/^daemon +SKIP +n\/a/m)
    expect(plain).not.toContain("\x1b[")
    const coloured = render(input({ daemon: { reachable: false } }), true)
    expect(coloured.split("\n")[0]).toBe("\x1b[1;31mCRIT\x1b[0m  daemon unreachable")
  })
})

describe("runHost health", () => {
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

  const daemonUp = () => discoverDaemon.mockResolvedValue({ found: { url: "http://127.0.0.1:9999" }, stale: [] })
  const route = (routes: Record<string, unknown>) =>
    httpGetJson.mockImplementation(async (url: string) => {
      for (const [prefix, body] of Object.entries(routes)) {
        if (url.startsWith(`http://127.0.0.1:9999${prefix}`)) {
          if (body instanceof Error) throw body
          return body
        }
      }
      throw new Error(`unexpected ${url}`)
    })

  it("healthy daemon: exit 0, reads /health, /host/load?detail=full and /sessions", async () => {
    daemonUp()
    route({
      "/health": { status: "ok", uptimeMs: 3 * 86_400_000 },
      "/host/load": HEALTHY,
      "/sessions": { sessions: [{ kind: "agent-cli", status: "running", alive: true, busy: true }] },
    })
    expect(await runHost(["health", "--no-color"])).toBe(0)
    expect(out.split("\n")[0]).toBe("OK  host has headroom for more agents")
    expect(out).toMatch(/^sessions +OK +1 live/m)
    expect(httpGetJson).toHaveBeenCalledWith("http://127.0.0.1:9999/health")
    expect(httpGetJson).toHaveBeenCalledWith("http://127.0.0.1:9999/host/load?detail=full&fresh=true")
    expect(localReport).not.toHaveBeenCalled()
  })

  it("exit codes follow the verdict (WARN 1, CRIT 2)", async () => {
    daemonUp()
    route({ "/health": { uptimeMs: 86_400_000 }, "/host/load": { ...HEALTHY, loadAvg: [25, 0, 0] }, "/sessions": { sessions: [] } })
    expect(await runHost(["health"])).toBe(1)
    expect(await runHost(["health", "--crit-load", "2.4"])).toBe(2)
  })

  it("unreachable daemon: CRIT, but the rest is reported from a local sample", async () => {
    daemonUp()
    route({ "/health": new Error("connect ECONNREFUSED 127.0.0.1:9999") })
    localReport.mockResolvedValue(HEALTHY)
    expect(await runHost(["health"])).toBe(2)
    expect(out.split("\n")[0]).toBe("CRIT  daemon unreachable (connect ECONNREFUSED 127.0.0.1:9999)")
    expect(out).toMatch(/^load +OK/m)
    expect(out).toMatch(/^sessions +SKIP/m)
    expect(localReport).toHaveBeenCalledWith([], { detail: "full", fresh: true })
  })

  it("no daemon found: CRIT with a local sample", async () => {
    discoverDaemon.mockResolvedValue({ found: null, stale: [] })
    localReport.mockResolvedValue(HEALTHY)
    expect(await runHost(["health"])).toBe(2)
    expect(out).toContain("daemon unreachable (no daemon found)")
    expect(httpGetJson).not.toHaveBeenCalled()
  })

  it("--local never contacts the daemon and skips the daemon/session checks", async () => {
    localReport.mockResolvedValue(HEALTHY)
    expect(await runHost(["health", "--local"])).toBe(0)
    expect(discoverDaemon).not.toHaveBeenCalled()
    expect(out).toMatch(/^daemon +SKIP/m)
  })

  it("daemon up but /host/load failing: falls back to a local sample, daemon stays OK", async () => {
    daemonUp()
    route({ "/health": { uptimeMs: 86_400_000 }, "/host/load": new Error("HTTP 404"), "/sessions": { sessions: [] } })
    localReport.mockResolvedValue(HEALTHY)
    expect(await runHost(["health"])).toBe(0)
    expect(out).toContain("it predates GET /host/load")
  })

  it("--json prints verdict, exitCode and checks[]", async () => {
    localReport.mockResolvedValue({ ...HEALTHY, loadAvg: [25, 0, 0] })
    expect(await runHost(["health", "--local", "--json"])).toBe(1)
    const j = JSON.parse(out)
    expect(j.verdict).toBe("WARN")
    expect(j.exitCode).toBe(1)
    expect(j.reasons).toEqual(["load 25.0 on 10 cores = 2.5x per core"])
    expect(j.checks[0]).toEqual({
      id: "load",
      label: "load",
      status: "WARN",
      value: 2.5,
      unit: "x",
      display: "2.50x per core",
      threshold: { warn: 2, crit: 4, direction: "above" },
      detail: "load 25.0 on 10 cores = 2.5x per core",
    })
    expect(j.thresholds.critLoadPerCore).toBe(4)
  })

  it("exits 2 (fail safe) when even the local sample fails", async () => {
    localReport.mockRejectedValue(new Error("ps denied"))
    expect(await runHost(["health", "--local"])).toBe(2)
    expect(err).toMatch(/ps denied/)
  })

  it("usage errors exit 64 and contact nothing", async () => {
    expect(await runHost(["health", "--nope"])).toBe(64)
    expect(await runHost(["health", "--watch", "0"])).toBe(64)
    expect(await runHost(["health", "--warn-load", "x"])).toBe(64)
    expect(await runHost(["health", "--warn-load", "9"])).toBe(64) // above the default crit 4
    expect(await runHost(["health", "extra"])).toBe(64)
    expect(discoverDaemon).not.toHaveBeenCalled()
    expect(localReport).not.toHaveBeenCalled()
  })

  it("--help documents the verdict, exit codes and the default thresholds", async () => {
    expect(await runHost(["health", "--help"])).toBe(0)
    expect(out).toContain("agentproto host health")
    expect(out).toContain("--warn-load <x>")
    expect(out).toContain(`>=${D.warnLoadPerCore}x/core`)
    expect(out).toContain("0 = OK, 1 = WARN, 2 = CRIT")
  })
})
