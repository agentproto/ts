import { describe, expect, it, vi } from "vitest"
import {
  buildHostLoadReport,
  collectHostSample,
  computeHostWarnings,
  createHostLoadService,
  DEFAULT_HOST_LOAD_THRESHOLDS,
  isSystemLike,
  parseDiskstats,
  parseIostat,
  parseLsofCwd,
  parseLsofListeners,
  parseMeminfo,
  parseProcStatCpu,
  parseSsListeners,
  parseSwapUsage,
  parseTopHeader,
  parseTopProcesses,
  parseVmStatMemory,
  scanRootOf,
  sizeToBytes,
  type HostProbes,
  type HostProcess,
  type HostProcessOwner,
} from "../host-load.js"
import type { CwdInfo, Footprint } from "../host-load.js"
import type { ProcRow, StatsSessionDescriptor } from "../process-stats.js"

// Captured from a Mac at loadavg ~600 (trimmed).
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                4326.
Pages active:                            442719.
Pages inactive:                          440702.
Pages speculative:                          563.
Pages throttled:                              0.
Pages wired down:                        358086.
Pages purgeable:                              0.
"Translation faults":                 123456789.
File-backed pages:                       257745.
Anonymous pages:                         626239.
Pages stored in compressor:             2500000.
Pages occupied by compressor:            814691.
`

const IOSTAT = `              disk0               disk6       cpu    load average
    KB/t  tps  MB/s     KB/t  tps  MB/s  us sy id   1m   5m   15m
   32.50 1494 47.44     5.76 3484 19.61  30 21 49  663.54 575.42 593.73
   21.41 1503 31.41     4.55 3500 15.54  50 50  0  663.54 575.42 593.73
`

const TOP = `Processes: 4123 total, 90 running, 4033 sleeping, 21000 threads
Load Avg: 663.54, 575.42, 593.73
CPU usage: 62.17% user, 37.82% sys, 0.0% idle
SharedLibs: 800M resident, 100M data, 60M linkedit.
MemRegions: 900000 total, 20G resident, 500M private, 6G shared.
PhysMem: 31G used (5518M wired, 12G compressor), 160M unused.
VM: 180T vsize, 4400M framework vsize, 0(0) swapins, 0(0) swapouts.

PID    MEM    CMPRS
73264  5674M  7715M
501    9G     1024K
77     512K+  0B
garbage
`

const SWAP = "vm.swapusage: total = 16384.00M  used = 15035.38M  free = 1348.62M  (encrypted)"

const GB = 1024 ** 3
const MB = 1024 ** 2

describe("sizeToBytes", () => {
  it("parses top and sysctl sizes", () => {
    expect(sizeToBytes("5674M")).toBe(5674 * MB)
    expect(sizeToBytes("12G")).toBe(12 * GB)
    expect(sizeToBytes("160K")).toBe(160 * 1024)
    expect(sizeToBytes("1.5G+")).toBe(1.5 * GB)
    expect(sizeToBytes("0B")).toBe(0)
    expect(sizeToBytes("512")).toBe(512)
    expect(sizeToBytes("junk")).toBeUndefined()
  })
})

describe("parseSwapUsage", () => {
  it("reads total, used, free and the percentage", () => {
    const s = parseSwapUsage(SWAP)!
    expect(s.totalBytes).toBe(16384 * MB)
    expect(s.usedBytes).toBe(Math.round(15035.38 * MB))
    expect(s.percent).toBe(91.8)
  })
  it("returns undefined for garbage", () => {
    expect(parseSwapUsage("nothing here")).toBeUndefined()
  })
})

describe("parseVmStatMemory", () => {
  it("splits wired / compressor / cached / free using the reported page size", () => {
    const m = parseVmStatMemory(VM_STAT, 32 * GB)!
    const page = 16384
    expect(m.wiredBytes).toBe(358086 * page)
    expect(m.compressorBytes).toBe(814691 * page)
    expect(m.cachedBytes).toBe(257745 * page)
    expect(m.freeBytes).toBe((4326 + 563) * page)
    expect(m.usedBytes).toBe((626239 + 358086 + 814691) * page)
    expect(m.availableBytes).toBe((4326 + 440702 + 563 + 0) * page)
    expect(m.totalBytes).toBe(32 * GB)
  })
  it("returns undefined without a page size", () => {
    expect(parseVmStatMemory("Pages free: 1.", GB)).toBeUndefined()
  })
})

describe("parseTopHeader", () => {
  it("reads CPU and PhysMem", () => {
    const h = parseTopHeader(TOP)
    expect(h.cpu).toEqual({ userPercent: 62.17, sysPercent: 37.82, idlePercent: 0, source: "top" })
    expect(h.mem).toEqual({
      usedBytes: 31 * GB,
      wiredBytes: 5518 * MB,
      compressorBytes: 12 * GB,
      unusedBytes: 160 * MB,
    })
  })
  it("is empty for text without the header", () => {
    expect(parseTopHeader("nope")).toEqual({})
  })
})

describe("parseTopProcesses", () => {
  it("adds compressed pages to resident memory and ignores non-rows", () => {
    const m = parseTopProcesses(TOP)
    expect(m.get(73264)).toEqual({ memoryBytes: (5674 + 7715) * MB, compressedBytes: 7715 * MB })
    expect(m.get(501)).toEqual({ memoryBytes: 9 * GB + MB, compressedBytes: MB })
    expect(m.get(77)).toEqual({ memoryBytes: 512 * 1024, compressedBytes: 0 })
    expect(m.size).toBe(3)
  })
  it("returns nothing when the PID header is missing", () => {
    expect(parseTopProcesses("Processes: 1\n").size).toBe(0)
  })
})

describe("parseIostat", () => {
  it("uses the last (1s interval) row for disks and CPU", () => {
    const r = parseIostat(IOSTAT)
    expect(r.intervals).toBe(2)
    expect(r.disks).toEqual([
      { name: "disk0", kbPerTransfer: 21.41, tps: 1503, mbPerSec: 31.41 },
      { name: "disk6", kbPerTransfer: 4.55, tps: 3500, mbPerSec: 15.54 },
    ])
    expect(r.cpu).toEqual({ userPercent: 50, sysPercent: 50, idlePercent: 0, source: "iostat" })
  })
  it("counts a single row as the since-boot sample only", () => {
    const one = IOSTAT.split("\n").slice(0, 3).join("\n")
    expect(parseIostat(one).intervals).toBe(1)
  })
  it("handles empty output", () => {
    expect(parseIostat("")).toEqual({ disks: [], intervals: 0 })
  })
})

describe("parseMeminfo", () => {
  it("derives memory and swap from /proc/meminfo", () => {
    const r = parseMeminfo(
      [
        "MemTotal:       16000000 kB",
        "MemFree:         1000000 kB",
        "MemAvailable:    6000000 kB",
        "Buffers:          200000 kB",
        "Cached:          3000000 kB",
        "SwapTotal:       4000000 kB",
        "SwapFree:        1000000 kB",
      ].join("\n"),
    )!
    expect(r.memory.totalBytes).toBe(16000000 * 1024)
    expect(r.memory.availableBytes).toBe(6000000 * 1024)
    expect(r.memory.usedBytes).toBe(10000000 * 1024)
    expect(r.memory.cachedBytes).toBe(3200000 * 1024)
    expect(r.swap?.percent).toBe(75)
  })
  it("is undefined without MemTotal", () => {
    expect(parseMeminfo("Foo: 1 kB")).toBeUndefined()
  })
})

describe("parseProcStatCpu", () => {
  it("computes percentages from the delta of two reads", () => {
    const before = "cpu  0 0 0 0 0 0 0 0 0 0\ncpu0 1 1 1 1 1 0 0 0 0 0"
    const after = "cpu  40 0 20 40 0 0 0 0 0 0\ncpu0 2 2 2 2 2 0 0 0 0 0"
    expect(parseProcStatCpu(before, after)).toEqual({
      userPercent: 40,
      sysPercent: 20,
      idlePercent: 40,
      source: "proc-stat",
    })
  })
  it("is undefined when nothing advanced", () => {
    const same = "cpu  1 1 1 1 1 0 0 0"
    expect(parseProcStatCpu(same, same)).toBeUndefined()
  })
})

describe("parseDiskstats", () => {
  const line = (name: string, reads: number, sectorsRead: number, writes: number, sectorsWritten: number): string =>
    `   8       0 ${name} ${reads} 0 ${sectorsRead} 0 ${writes} 0 ${sectorsWritten} 0 0 0 0`
  it("reports whole disks only, as rates", () => {
    const before = [line("sda", 100, 1000, 100, 1000), line("sda1", 1, 1, 1, 1), line("nvme0n1", 0, 0, 0, 0)].join("\n")
    const after = [line("sda", 300, 5096, 300, 5096), line("sda1", 9, 9, 9, 9), line("nvme0n1", 0, 0, 0, 0)].join("\n")
    const d = parseDiskstats(before, after, 2)
    expect(d.map(x => x.name)).toEqual(["sda", "nvme0n1"])
    // 400 ops / 2s, 8192 sectors * 512 B = 4 MiB / 2s
    expect(d[0]).toMatchObject({ name: "sda", tps: 200, mbPerSec: 2, kbPerTransfer: 10.2 })
    expect(d[1]).toEqual({ name: "nvme0n1", tps: 0, mbPerSec: 0 })
  })
})

describe("listener and cwd parsers", () => {
  it("parses lsof listeners, deduping ports per pid", () => {
    const out = "p100\nn*:5173\nn[::1]:5173\nn127.0.0.1:3000\np200\nn*:5173\n"
    const m = parseLsofListeners(out)
    expect(m.get(100)).toEqual([5173, 3000])
    expect(m.get(200)).toEqual([5173])
  })
  it("parses ss listeners", () => {
    const out = [
      `LISTEN 0 511 0.0.0.0:5173 0.0.0.0:* users:(("node",pid=10,fd=20))`,
      `LISTEN 0 511 [::]:3000 [::]:* users:(("node",pid=11,fd=21),("node",pid=12,fd=21))`,
    ].join("\n")
    const m = parseSsListeners(out)
    expect(m.get(10)).toEqual([5173])
    expect(m.get(11)).toEqual([3000])
    expect(m.get(12)).toEqual([3000])
  })
  it("parses lsof cwd and ignores other fds", () => {
    const out = "p100\nfcwd\nn/Users/me/proj\nftxt\nn/usr/bin/node\np200\nfcwd\nn/tmp/gone\n"
    const m = parseLsofCwd(out)
    expect(m.get(100)).toBe("/Users/me/proj")
    expect(m.get(200)).toBe("/tmp/gone")
    expect(m.size).toBe(2)
  })
})

describe("scanRootOf", () => {
  const home = "/Users/me"
  it("flags find/bfs/du rooted at / or the home directory", () => {
    expect(scanRootOf("bfs / -name '*.log'", home)).toBe("/")
    expect(scanRootOf("/usr/bin/find / -type f -name x", home)).toBe("/")
    expect(scanRootOf("find ~ -name x", home)).toBe("~")
    expect(scanRootOf("find /Users/me -name x", home)).toBe("/Users/me")
    expect(scanRootOf("find -L / -name x", home)).toBe("/")
    expect(scanRootOf("du -sh /", home)).toBe("/")
    expect(scanRootOf("du -sk -x /Volumes", home)).toBe("/Volumes")
  })
  it("ignores scoped scans and non-scan commands", () => {
    expect(scanRootOf("find /Users/me/proj -name x", home)).toBeUndefined()
    expect(scanRootOf("find . -name x", home)).toBeUndefined()
    expect(scanRootOf("find -name /", home)).toBeUndefined()
    expect(scanRootOf("node /", home)).toBeUndefined()
    expect(scanRootOf("grep -r foo /", home)).toBeUndefined()
  })
})

describe("isSystemLike", () => {
  it("recognises OS paths, apps and other low uids", () => {
    expect(isSystemLike({ uid: 501, args: "/System/Library/CoreServices/Finder" }, 501, "darwin")).toBe(true)
    expect(isSystemLike({ uid: 501, args: "/Applications/Slack.app/Contents/MacOS/Slack" }, 501, "darwin")).toBe(true)
    expect(isSystemLike({ uid: 0, args: "watchman" }, 501, "darwin")).toBe(true)
    expect(isSystemLike({ uid: 1000, args: "/usr/lib/systemd/systemd" }, 1000, "linux")).toBe(true)
  })
  it("does not call the user's own tools system", () => {
    expect(isSystemLike({ uid: 501, args: "node -e mkdirSync" }, 501, "darwin")).toBe(false)
    expect(isSystemLike({ uid: 501, args: "/opt/homebrew/bin/watchman" }, 501, "darwin")).toBe(false)
    expect(isSystemLike({ uid: 502, args: "vite" }, 501, "darwin")).toBe(false)
  })
})

function proc(over: Partial<HostProcess> & { pid: number }): HostProcess {
  const { pid, ...rest } = over
  return {
    pid,
    ppid: 1,
    uid: 501,
    command: "node",
    args: "node x.js",
    rssBytes: 1024,
    memoryBytes: 1024,
    memorySource: "rss",
    cpuPercent: 0,
    elapsedSec: 10,
    owner: { kind: "other" },
    ...rest,
  }
}

const ORPHAN: HostProcessOwner = { kind: "orphan" }

describe("computeHostWarnings", () => {
  const base = { loadAvg: [2, 2, 2] as [number, number, number], cpuCount: 8, homeDir: "/Users/me" }

  it("is quiet on a healthy host", () => {
    expect(computeHostWarnings({ ...base, processes: [proc({ pid: 5 })] })).toEqual([])
  })

  it("flags load above 4x the core count", () => {
    const w = computeHostWarnings({ ...base, loadAvg: [600, 500, 500], processes: [] })
    expect(w).toHaveLength(1)
    expect(w[0]).toMatchObject({ kind: "load", severity: "critical" })
    expect(w[0]!.message).toMatch(/75x the 8 cores/)
    expect(computeHostWarnings({ ...base, loadAvg: [32, 0, 0], processes: [] })).toEqual([]) // exactly 4x
  })

  it("flags swap above 50% (warn) and 85% (critical)", () => {
    const swap = (percent: number) => ({ totalBytes: 100 * GB, usedBytes: percent * GB, freeBytes: (100 - percent) * GB, percent })
    expect(computeHostWarnings({ ...base, swap: swap(50), processes: [] })).toEqual([])
    expect(computeHostWarnings({ ...base, swap: swap(60), processes: [] })[0]).toMatchObject({ kind: "swap", severity: "warn" })
    expect(computeHostWarnings({ ...base, swap: swap(92), processes: [] })[0]).toMatchObject({ kind: "swap", severity: "critical" })
  })

  it("flags old busy orphans and orphaned dev servers, not young or idle ones", () => {
    const min = DEFAULT_HOST_LOAD_THRESHOLDS.orphanMinAgeSec
    const w = computeHostWarnings({
      ...base,
      processes: [
        proc({ pid: 10, owner: ORPHAN, elapsedSec: min + 1, cpuPercent: 90, args: "node -e mkdirSync(...)" }),
        proc({ pid: 11, owner: ORPHAN, elapsedSec: min + 1, cpuPercent: 0, args: "node vite --port 5173", listening: [5173] }),
        proc({ pid: 12, owner: ORPHAN, elapsedSec: min - 1, cpuPercent: 99 }), // too young
        proc({ pid: 13, owner: ORPHAN, elapsedSec: min + 1, cpuPercent: 1 }), // idle, not serving
        proc({ pid: 14, owner: ORPHAN, elapsedSec: min + 1, cpuPercent: 0, args: "postgres", listening: [5432] }), // serving, not a dev server
        proc({ pid: 15, owner: { kind: "system" }, elapsedSec: min + 1, cpuPercent: 99 }), // not an orphan
      ],
    })
    const orphans = w.filter(x => x.kind === "orphan")
    expect(orphans.map(x => x.pids)).toEqual([[10], [11]])
    expect(orphans[1]!.message).toMatch(/listening on 5173/)
  })

  it("flags deleted-cwd processes", () => {
    const w = computeHostWarnings({ ...base, processes: [proc({ pid: 20, cwdDeleted: true, cpuPercent: 99, elapsedSec: 2580 })] })
    expect(w).toHaveLength(1)
    expect(w[0]).toMatchObject({ kind: "deleted-cwd", pids: [20] })
    expect(w[0]!.message).toMatch(/43m/)
  })

  it("flags filesystem-wide scans", () => {
    const w = computeHostWarnings({
      ...base,
      processes: [proc({ pid: 30, args: "bfs / -name x", elapsedSec: 2760 }), proc({ pid: 31, args: "find ./src -name x" })],
    })
    expect(w).toHaveLength(1)
    expect(w[0]).toMatchObject({ kind: "fs-scan", pids: [30] })
    expect(w[0]!.message).toMatch(/46m/)
  })

  it("flags several unrelated servers on one port but not forked workers", () => {
    const w = computeHostWarnings({
      ...base,
      processes: [
        proc({ pid: 40, ppid: 1, listening: [5173], command: "vite", elapsedSec: 86400 }),
        proc({ pid: 41, ppid: 1, listening: [5173], command: "vite", elapsedSec: 86400 }),
        proc({ pid: 42, ppid: 1, listening: [5173], command: "vite", elapsedSec: 86400 }),
        proc({ pid: 50, ppid: 49, listening: [3000] }),
        proc({ pid: 51, ppid: 49, listening: [3000] }), // same parent: cluster workers
      ],
    })
    const dups = w.filter(x => x.kind === "duplicate-port")
    expect(dups).toHaveLength(1)
    expect(dups[0]).toMatchObject({ pids: [40, 41, 42] })
    expect(dups[0]!.message).toMatch(/3 servers listening on port 5173/)
  })
})

// ── collection ──────────────────────────────────────────────────────

const row = (pid: number, ppid: number, args: string, o: Partial<ProcRow> = {}): ProcRow => ({
  pid,
  ppid,
  uid: 501,
  rssKib: 1000,
  cpuPercent: 0,
  elapsedSec: 60,
  args,
  ...o,
})

const TABLE: ProcRow[] = [
  row(1, 0, "/sbin/launchd", { uid: 0 }),
  row(10, 1, "node /opt/agentproto/daemon.js", { rssKib: 50_000 }),
  row(20, 10, "claude", { rssKib: 3000, cpuPercent: 2 }),
  row(21, 20, "node /r/node_modules/vitest/dist/workers/forks.js", { rssKib: 9000, cpuPercent: 40 }),
  row(300, 1, "node -e require('fs').mkdirSync('x')", { rssKib: 4000, cpuPercent: 95, elapsedSec: 2580 }),
  row(400, 1, "/opt/homebrew/bin/node /r/node_modules/.bin/vite --port 5173", { rssKib: 90_000, elapsedSec: 86_400 }),
  row(401, 1, "/opt/homebrew/bin/node /r/node_modules/.bin/vite --port 5173", { rssKib: 90_000, elapsedSec: 86_400 }),
  row(500, 1, "/System/Library/CoreServices/mds", { uid: 0, rssKib: 60_000, cpuPercent: 30 }),
  row(600, 77, "vim notes.txt", { rssKib: 2000 }),
]

const SESSIONS: StatsSessionDescriptor[] = [{ id: "sess_a", pid: 20, status: "running", label: "builder" }]

function fakeProbes(over: Partial<HostProbes> = {}): HostProbes {
  return {
    platform: "darwin",
    table: async () => TABLE,
    vmStat: async () => VM_STAT,
    swapUsage: async () => SWAP,
    iostat: async () => IOSTAT,
    top: async () => TOP,
    listeners: async () => "p400\nn*:5173\np401\nn*:5173\n",
    cwds: async pids => {
      const m = new Map<number, CwdInfo>()
      if (pids.includes(300)) m.set(300, { path: "/tmp/gone", deleted: true })
      return m
    },
    envHints: async () => new Map(),
    loadAvg: () => [600, 500, 500],
    cpuCount: () => 8,
    totalMem: () => 32 * GB,
    ...over,
  }
}

describe("collectHostSample", () => {
  it("folds every probe into one sample", async () => {
    const s = await collectHostSample(fakeProbes(), SESSIONS, { uid: 501, daemonPid: 10 })
    expect(s.partial).toEqual([])
    expect(s.cpu).toEqual({ userPercent: 50, sysPercent: 50, idlePercent: 0, source: "iostat" })
    expect(s.memory.wiredBytes).toBe(358086 * 16384)
    expect(s.swap?.percent).toBe(91.8)
    expect(s.disks.map(d => d.name)).toEqual(["disk0", "disk6"])
    expect(s.table).toHaveLength(TABLE.length)
    expect(s.footprints.get(73264)?.memoryBytes).toBe((5674 + 7715) * MB)
    expect(s.listeners.get(400)).toEqual([5173])
    expect(s.cwds.get(300)?.deleted).toBe(true)
    expect(s.loadAvg).toEqual([600, 500, 500])
    expect(s.cpuCount).toBe(8)
  })

  it("names a failing probe in partial and keeps the rest", async () => {
    const s = await collectHostSample(
      fakeProbes({
        iostat: async () => {
          throw new Error("iostat: not found")
        },
      }),
      SESSIONS,
      { uid: 501 },
    )
    expect(s.partial).toEqual(["iostat: iostat: not found"])
    expect(s.cpu?.source).toBe("top") // fell back to the top header
    expect(s.disks).toEqual([])
    expect(s.swap?.percent).toBe(91.8)
    expect(s.table).toHaveLength(TABLE.length)
  })

  it("does not wait for a hanging probe past the budget", async () => {
    const t0 = Date.now()
    const s = await collectHostSample(fakeProbes({ top: () => new Promise(() => {}) }), SESSIONS, {
      budgetMs: 400,
      uid: 501,
    })
    expect(Date.now() - t0).toBeLessThan(1500)
    expect(s.partial.some(p => p.startsWith("top: timed out"))).toBe(true)
    expect(s.footprints.size).toBe(0)
    expect(s.table).toHaveLength(TABLE.length)
  })

  it("skips probes once the budget is spent", async () => {
    let clock = 0
    const s = await collectHostSample(
      fakeProbes({
        table: async () => {
          clock += 5000
          return TABLE
        },
      }),
      SESSIONS,
      { budgetMs: 1000, now: () => clock, uid: 501 },
    )
    expect(s.partial.some(p => /skipped \(budget exhausted\)/.test(p))).toBe(true)
  })

  it("flags an iostat that only produced the since-boot row", async () => {
    const one = IOSTAT.split("\n").slice(0, 3).join("\n")
    const s = await collectHostSample(fakeProbes({ iostat: async () => one }), SESSIONS, { uid: 501 })
    expect(s.partial.some(p => /since-boot/.test(p))).toBe(true)
    expect(s.disks).toEqual([])
    expect(s.cpu?.source).toBe("top")
  })

  it("drops the collector's own child processes from the table", async () => {
    const s = await collectHostSample(
      fakeProbes({
        table: async () => [...TABLE, row(9000, 10, "top -l 1 -n 40"), row(9001, 10, "ps -A -ww -o pid=,ppid=,uid=,rss=,pcpu=,etime=,command=")],
        ownPids: () => new Set([9000]),
      }),
      SESSIONS,
      { uid: 501 },
    )
    expect(s.table.map(r => r.pid)).not.toContain(9000)
    expect(s.table.map(r => r.pid)).not.toContain(9001)
  })

  it("uses the Linux probes: meminfo, /proc/stat, diskstats, smaps", async () => {
    const stat = (u: number, i: number) => `cpu  ${u} 0 0 ${i} 0 0 0 0`
    const disk = (n: number) => `   8 0 sda ${n} 0 ${n * 8} 0 0 0 0 0 0 0 0`
    const s = await collectHostSample(
      {
        platform: "linux",
        table: async () => TABLE,
        meminfo: async () => "MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 400 kB\nSwapTotal: 100 kB\nSwapFree: 40 kB",
        cpuDisk: async () => ({
          statBefore: stat(0, 0),
          statAfter: stat(50, 50),
          diskBefore: disk(0),
          diskAfter: disk(100),
          intervalSec: 1,
        }),
        smaps: async pids => {
          const m = new Map<number, Footprint>()
          if (pids.includes(400)) m.set(400, { memoryBytes: 5 * MB, compressedBytes: MB })
          return m
        },
        listeners: async () => `LISTEN 0 1 0.0.0.0:5173 0.0.0.0:* users:(("node",pid=400,fd=1))`,
        loadAvg: () => [1, 1, 1],
        cpuCount: () => 4,
        totalMem: () => 1000 * 1024,
      },
      [],
      { uid: 501 },
    )
    expect(s.memory.availableBytes).toBe(400 * 1024)
    expect(s.swap?.percent).toBe(60)
    expect(s.cpu).toMatchObject({ source: "proc-stat", userPercent: 50, idlePercent: 50 })
    expect(s.disks[0]).toMatchObject({ name: "sda", tps: 100 })
    expect(s.footprints.get(400)?.memoryBytes).toBe(5 * MB)
    expect(s.listeners.get(400)).toEqual([5173])
  })
})

describe("buildHostLoadReport", () => {
  async function report(detail: "summary" | "full" = "summary", visible?: ReadonlySet<string>) {
    const sample = await collectHostSample(fakeProbes(), SESSIONS, { uid: 501, daemonPid: 10 })
    return buildHostLoadReport(sample, {
      sessions: SESSIONS,
      detail,
      uid: 501,
      daemonPid: 10,
      homeDir: "/Users/me",
      ...(visible ? { visible } : {}),
    })
  }

  it("labels each heavy process with its owner", async () => {
    const r = await report("full")
    const byPid = new Map(r.processes!.map(p => [p.pid, p]))
    expect(byPid.get(21)?.owner).toEqual({ kind: "session", sessionId: "sess_a", label: "builder" })
    expect(byPid.get(10)?.owner).toEqual({ kind: "daemon" })
    expect(byPid.get(300)?.owner.kind).toBe("orphan")
    expect(byPid.get(400)?.owner.kind).toBe("orphan")
    expect(byPid.get(500)?.owner).toEqual({ kind: "system" })
    expect(byPid.get(600)?.owner).toEqual({ kind: "other" })
  })

  it("reports load, memory, swap, disks and sorted top lists", async () => {
    const r = await report()
    expect(r.detail).toBe("summary")
    expect(r.loadPerCore).toBe(75)
    expect(r.memory.compressorBytes).toBe(814691 * 16384)
    expect(r.swap?.percent).toBe(91.8)
    expect(r.disks).toHaveLength(2)
    expect(r.topByCpu.map(p => p.pid).slice(0, 3)).toEqual([300, 21, 500])
    expect(r.topByMemory[0]!.pid).toBe(400)
    expect(r.sessions).toBeUndefined()
    expect(r.processes).toBeUndefined()
  })

  it("prefers the footprint over rss when top measured one, and marks the source", async () => {
    const sample = await collectHostSample(
      fakeProbes({ top: async () => "PID MEM CMPRS\n 21 100M 900M\n" }),
      SESSIONS,
      { uid: 501, daemonPid: 10 },
    )
    const r = buildHostLoadReport(sample, { sessions: SESSIONS, detail: "full", uid: 501, daemonPid: 10 })
    const p = r.processes!.find(x => x.pid === 21)!
    expect(p).toMatchObject({ memorySource: "footprint", memoryBytes: 1000 * MB, compressedBytes: 900 * MB })
    expect(r.processes!.find(x => x.pid === 20)).toMatchObject({ memorySource: "rss", memoryBytes: 3000 * 1024 })
    expect(r.topByMemory[0]!.pid).toBe(21)
  })

  it("raises every warning kind the fixtures contain", async () => {
    const r = await report()
    const kinds = new Set(r.warnings.map(w => w.kind))
    expect(kinds).toEqual(new Set(["load", "swap", "orphan", "deleted-cwd", "duplicate-port"]))
    expect(r.warnings.find(w => w.kind === "duplicate-port")?.pids).toEqual([400, 401])
    expect(r.warnings.find(w => w.kind === "deleted-cwd")?.pids).toEqual([300])
  })

  it("rolls processes up per session in full detail", async () => {
    const r = await report("full")
    expect(r.sessions).toEqual([
      { sessionId: "sess_a", label: "builder", rssBytes: 12_000 * 1024, memoryBytes: 12_000 * 1024, cpuPercent: 42, procCount: 2 },
    ])
    expect(r.processes).toHaveLength(TABLE.length)
    expect(r.processes![0]!.memoryBytes).toBeGreaterThanOrEqual(r.processes!.at(-1)!.memoryBytes)
  })

  it("scopes to the visible sessions and drops other processes' warnings", async () => {
    const r = await report("full", new Set(["sess_a"]))
    expect(r.scoped).toBe(true)
    expect(r.processes!.map(p => p.pid).sort((a, b) => a - b)).toEqual([20, 21])
    expect(r.warnings.map(w => w.kind).sort()).toEqual(["load", "swap"])
    const none = await report("summary", new Set())
    expect(none.topByCpu).toEqual([])
  })
})

describe("createHostLoadService", () => {
  const tracker = { begin: () => () => {}, list: () => [] }

  it("reuses a sample within the TTL and re-samples after it or with fresh", async () => {
    let clock = 1000
    const table = vi.fn(async () => TABLE)
    const svc = createHostLoadService({ probes: fakeProbes({ table }), tracker, now: () => clock, ttlMs: 2000, uid: 501 })
    await svc.report(SESSIONS)
    await svc.report(SESSIONS, { detail: "full" })
    expect(table).toHaveBeenCalledTimes(1)
    clock += 2500
    await svc.report(SESSIONS)
    expect(table).toHaveBeenCalledTimes(2)
    await svc.report(SESSIONS, { fresh: true })
    expect(table).toHaveBeenCalledTimes(3)
  })

  it("shares one in-flight collection between concurrent callers", async () => {
    const table = vi.fn(async () => TABLE)
    const svc = createHostLoadService({ probes: fakeProbes({ table }), tracker, uid: 501 })
    await Promise.all([svc.report(SESSIONS), svc.report(SESSIONS), svc.report(SESSIONS)])
    expect(table).toHaveBeenCalledTimes(1)
  })

  it("re-samples a partial cached sample when a larger budget is asked for", async () => {
    let n = 0
    const top = vi.fn(async () => {
      if (++n === 1) throw new Error("top: slow")
      return TOP
    })
    const svc = createHostLoadService({ probes: fakeProbes({ top }), tracker, uid: 501, budgetMs: 1000 })
    const first = await svc.report(SESSIONS)
    expect(first.partial).toEqual(["top: top: slow"])
    expect((await svc.report(SESSIONS)).partial).toHaveLength(1) // same budget: cached
    expect(top).toHaveBeenCalledTimes(1)
    const second = await svc.report(SESSIONS, { budgetMs: 5000 })
    expect(top).toHaveBeenCalledTimes(2)
    expect(second.partial).toEqual([])
  })

  it("does not cache a failed collection", async () => {
    let calls = 0
    const svc = createHostLoadService({
      probes: fakeProbes({
        table: async () => {
          calls++
          return TABLE
        },
        totalMem: () => {
          if (calls === 1) throw new Error("boom")
          return 32 * GB
        },
      }),
      tracker,
      uid: 501,
    })
    await expect(svc.report(SESSIONS)).rejects.toThrow("boom")
    await expect(svc.report(SESSIONS)).resolves.toMatchObject({ platform: "darwin" })
  })
})
