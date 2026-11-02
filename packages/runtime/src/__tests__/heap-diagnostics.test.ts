/**
 * `heap-diagnostics.ts`: the periodic `[heap]` report and the guarded
 * on-demand heap snapshot (E99).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  availableMemoryBytes,
  DEFAULT_HEAP_LOG_INTERVAL_MS,
  formatHeapLine,
  heapLogIntervalFromEnv,
  startHeapMonitor,
  writeHeapSnapshotGuarded,
} from "../heap-diagnostics.js"

const MB = 1024 * 1024

function mem(heapUsed: number): NodeJS.MemoryUsage {
  return { rss: 900 * MB, heapTotal: 1200 * MB, heapUsed, external: 50 * MB, arrayBuffers: 10 * MB }
}

const dirs: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

describe("startHeapMonitor", () => {
  it("reports memory, the floor after the last major GC, handles and every probe", () => {
    let fireGc: () => void = () => {}
    let heapUsed = 700 * MB
    const monitor = startHeapMonitor({
      intervalMs: 0,
      memoryUsage: () => mem(heapUsed),
      activeResources: () => ["Timeout", "TCPSocketWrap", "Timeout"],
      now: () => new Date("2026-11-02T01:00:00.000Z"),
      observeGc: cb => {
        fireGc = cb
        return () => {}
      },
      probes: {
        sessions: () => ({ total: 12, live: 3 }),
        broken: () => {
          throw new Error("nope")
        },
      },
    })
    expect(monitor.report().afterMajorGc).toBeUndefined()
    heapUsed = 640 * MB
    fireGc()
    heapUsed = 1800 * MB
    const r = monitor.report()
    expect(r.afterMajorGc).toEqual({ heapUsed: 640 * MB, at: "2026-11-02T01:00:00.000Z" })
    expect(r.majorGcs).toBe(1)
    expect(r.memory.heapUsed).toBe(1800 * MB)
    expect(r.handles).toEqual({ Timeout: 2, TCPSocketWrap: 1 })
    expect(r.structures).toEqual({ sessions: { total: 12, live: 3 }, broken: { error: "nope" } })
    const line = formatHeapLine(r)
    expect(line).toBe(
      "[heap] heapUsed=1800MB heapTotal=1200MB rss=900MB external=50MB arrayBuffers=10MB " +
        "afterMajorGc=640MB@2026-11-02T01:00:00.000Z majorGcs=1 handles=Timeout:2,TCPSocketWrap:1 " +
        "sessions=total:12,live:3 broken=error",
    )
    monitor.stop()
  })

  it("logs one line per interval and stops cleanly", () => {
    vi.useFakeTimers()
    const lines: string[] = []
    let unobserved = false
    const monitor = startHeapMonitor({
      intervalMs: 1000,
      log: l => lines.push(l),
      memoryUsage: () => mem(100 * MB),
      activeResources: () => [],
      observeGc: () => () => {
        unobserved = true
      },
    })
    vi.advanceTimersByTime(3500)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/^\[heap\] heapUsed=100MB .* afterMajorGc=none majorGcs=0 handles=none$/)
    monitor.stop()
    vi.advanceTimersByTime(5000)
    expect(lines).toHaveLength(3)
    expect(unobserved).toBe(true)
  })

  // Only meaningful under --expose-gc.
  const gc = (globalThis as { gc?: () => void }).gc
  it.runIf(gc !== undefined)("observes real major GCs by default", async () => {
    const monitor = startHeapMonitor({ intervalMs: 0 })
    gc!()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(monitor.report().majorGcs).toBeGreaterThan(0)
    monitor.stop()
  })
})

describe("heapLogIntervalFromEnv", () => {
  it("defaults, honours an override, and lets 0 disable the line", () => {
    expect(heapLogIntervalFromEnv({})).toBe(DEFAULT_HEAP_LOG_INTERVAL_MS)
    expect(heapLogIntervalFromEnv({ AGENTPROTO_HEAP_LOG_INTERVAL_MS: "60000" })).toBe(60000)
    expect(heapLogIntervalFromEnv({ AGENTPROTO_HEAP_LOG_INTERVAL_MS: "0" })).toBe(0)
    expect(heapLogIntervalFromEnv({ AGENTPROTO_HEAP_LOG_INTERVAL_MS: "soon" })).toBe(DEFAULT_HEAP_LOG_INTERVAL_MS)
  })

  it("never returns a delay setInterval would overflow into 1ms", () => {
    const max = 2 ** 31 - 1
    expect(heapLogIntervalFromEnv({ AGENTPROTO_HEAP_LOG_INTERVAL_MS: String(max) })).toBe(max)
    expect(heapLogIntervalFromEnv({ AGENTPROTO_HEAP_LOG_INTERVAL_MS: String(max + 1) })).toBeLessThanOrEqual(max)
    expect(heapLogIntervalFromEnv({ AGENTPROTO_HEAP_LOG_INTERVAL_MS: "1e15" })).toBeLessThanOrEqual(max)
  })
})

describe("availableMemoryBytes", () => {
  async function cgroup(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "heap-cgroup-test-"))
    dirs.push(dir)
    for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body)
    return dir
  }

  it("caps free memory at the cgroup v2 limit minus current usage", async () => {
    const dir = await cgroup({ "memory.max": `${1024 * MB}\n`, "memory.current": `${900 * MB}\n` })
    expect(availableMemoryBytes({ cgroupDir: dir, freeMemory: () => 8192 * MB })).toBe(124 * MB)
  })

  it("keeps os free memory when it is lower than the cgroup room", async () => {
    const dir = await cgroup({ "memory.max": `${4096 * MB}\n`, "memory.current": `${100 * MB}\n` })
    expect(availableMemoryBytes({ cgroupDir: dir, freeMemory: () => 512 * MB })).toBe(512 * MB)
  })

  it("falls back to os free memory with no limit or no cgroup files", async () => {
    const unlimited = await cgroup({ "memory.max": "max\n", "memory.current": `${900 * MB}\n` })
    expect(availableMemoryBytes({ cgroupDir: unlimited, freeMemory: () => 2048 * MB })).toBe(2048 * MB)
    const empty = await cgroup({})
    expect(availableMemoryBytes({ cgroupDir: empty, freeMemory: () => 2048 * MB })).toBe(2048 * MB)
  })
})

describe("writeHeapSnapshotGuarded", () => {
  it("refuses when free memory cannot hold the heap plus headroom, and writes nothing", () => {
    const write = vi.fn((p: string) => p)
    const r = writeHeapSnapshotGuarded({
      freeMemory: () => 900 * MB,
      memoryUsage: () => mem(800 * MB),
      headroomBytes: 256 * MB,
      write,
    })
    expect(r).toMatchObject({ ok: false, error: "insufficient_memory", requiredBytes: 1056 * MB, freeBytes: 900 * MB })
    expect(write).not.toHaveBeenCalled()
  })

  it("refuses when the cgroup limit, not host free memory, cannot hold the snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "heap-cgroup-test-"))
    dirs.push(dir)
    await writeFile(join(dir, "memory.max"), `${1024 * MB}\n`)
    await writeFile(join(dir, "memory.current"), `${900 * MB}\n`)
    const write = vi.fn((p: string) => p)
    const r = writeHeapSnapshotGuarded({
      cgroupDir: dir,
      osFreeMemory: () => 8192 * MB,
      memoryUsage: () => mem(10 * MB),
      headroomBytes: 256 * MB,
      write,
    })
    expect(r).toMatchObject({ ok: false, error: "insufficient_memory", freeBytes: 124 * MB })
    expect(write).not.toHaveBeenCalled()
  })

  it("writes under the given dir with a timestamped name and returns the blocking warning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "heap-snap-test-"))
    dirs.push(dir)
    const write = vi.fn((p: string) => p)
    const r = writeHeapSnapshotGuarded({
      dir: join(dir, "heap-snapshots"),
      freeMemory: () => 4096 * MB,
      memoryUsage: () => mem(800 * MB),
      now: () => new Date("2026-11-02T01:02:03.004Z"),
      write,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.path).toBe(join(dir, "heap-snapshots", `heap-2026-11-02T01-02-03-004Z-${process.pid}.heapsnapshot`))
    expect(write).toHaveBeenCalledWith(r.path)
    expect(r.warning).toMatch(/blocks the daemon's event loop/)
  })

  it("reports a failed write instead of throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "heap-snap-test-"))
    dirs.push(dir)
    const r = writeHeapSnapshotGuarded({
      dir,
      freeMemory: () => 4096 * MB,
      memoryUsage: () => mem(10 * MB),
      write: () => {
        throw new Error("EACCES")
      },
    })
    expect(r).toEqual({ ok: false, error: "snapshot_failed", message: "EACCES" })
  })
})
