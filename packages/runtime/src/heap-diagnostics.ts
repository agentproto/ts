/**
 * Heap diagnostics for the long-running daemon (E99).
 *
 * Two operator aids, both cheap enough to stay on:
 *
 *  - a periodic `[heap]` log line: `heapUsed`/`rss`, the heap measured right
 *    after the last major GC (the retained floor, as opposed to `heapUsed`,
 *    which also counts garbage V8 has not collected yet: under a large
 *    `--max-old-space-size` it can sit GBs above the floor between major
 *    GCs), the live handle counts by type, and the sizes of the daemon's
 *    long-lived structures (session registry, hosts, pairing loops, ...).
 *    A floor that climbs while the structure sizes stay flat points at a
 *    retainer nobody counts yet; a structure that climbs with it names the
 *    owner.
 *  - an on-demand heap snapshot (`writeHeapSnapshotGuarded`) for the
 *    operator-only `POST /debug/heap-snapshot` route. It refuses when free
 *    memory (capped by the cgroup v2 limit, if any) cannot hold it and writes under `~/.agentproto/heap-snapshots/`.
 *    `v8.writeHeapSnapshot` is synchronous: it blocks the event loop for its
 *    whole duration (seconds per GB of heap), which also means two snapshots
 *    can never overlap.
 */

import { mkdirSync, readFileSync } from "node:fs"
import { freemem, homedir } from "node:os"
import { join } from "node:path"
import { constants as perfConstants, PerformanceObserver } from "node:perf_hooks"
import { writeHeapSnapshot } from "node:v8"

/** Default cadence of the `[heap]` log line. */
export const DEFAULT_HEAP_LOG_INTERVAL_MS = 5 * 60_000

/** Env override for the cadence, in ms. `0` turns the line off. */
export const HEAP_LOG_INTERVAL_ENV = "AGENTPROTO_HEAP_LOG_INTERVAL_MS"

/** Largest delay `setInterval` honours: Node turns anything above it into
 *  1 ms (with a `TimeoutOverflowWarning`), a hot loop for the `[heap]` line. */
export const MAX_HEAP_LOG_INTERVAL_MS = 2 ** 31 - 1

/** Free memory a snapshot needs on top of the live heap: writing one costs
 *  roughly the heap again in native memory, plus headroom for the daemon. */
export const HEAP_SNAPSHOT_HEADROOM_BYTES = 256 * 1024 * 1024

/** One named owner of long-lived state, reporting its current sizes
 *  (entry counts or bytes). Must be cheap;
 *  a throwing probe is reported as `error` instead of failing the line. */
export type HeapProbe = () => Record<string, number>

export interface HeapReport {
  at: string
  memory: NodeJS.MemoryUsage
  /** `heapUsed` sampled right after the last major (mark-compact) GC, and
   *  when. Absent until the first major GC of this process. */
  afterMajorGc?: { heapUsed: number; at: string }
  majorGcs: number
  /** `process.getActiveResourcesInfo()` grouped by type (Timeout, TCPWRAP,
   *  FSReqCallback, ...): a timer or socket that leaks shows up here. */
  handles: Record<string, number>
  /** Per-probe sizes, keyed by probe name. */
  structures: Record<string, Record<string, number> | { error: string }>
}

export interface HeapMonitor {
  report(): HeapReport
  stop(): void
}

export interface HeapMonitorOptions {
  probes?: Record<string, HeapProbe>
  /** `0` or negative: no periodic line (the report stays available). */
  intervalMs?: number
  log?: (line: string) => void
  memoryUsage?: () => NodeJS.MemoryUsage
  activeResources?: () => string[]
  now?: () => Date
  /** Subscribe to GC completions (seam for tests). Returns an unsubscribe. */
  observeGc?: (onMajorGc: () => void) => () => void
}

/** Resolve the log cadence from the env, falling back to the default. */
export function heapLogIntervalFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[HEAP_LOG_INTERVAL_ENV]
  if (raw === undefined || raw.trim() === "") return DEFAULT_HEAP_LOG_INTERVAL_MS
  const n = Number(raw)
  return Number.isFinite(n) ? Math.min(n, MAX_HEAP_LOG_INTERVAL_MS) : DEFAULT_HEAP_LOG_INTERVAL_MS
}

function defaultObserveGc(onMajorGc: () => void): () => void {
  const obs = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      const kind = (entry as { detail?: { kind?: number } }).detail?.kind
      if (kind === perfConstants.NODE_PERFORMANCE_GC_MAJOR) onMajorGc()
    }
  })
  obs.observe({ entryTypes: ["gc"] })
  return () => obs.disconnect()
}

function groupHandles(list: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of list) out[t] = (out[t] ?? 0) + 1
  return out
}

const MB = 1024 * 1024
const mb = (n: number): string => `${Math.round(n / MB)}MB`

/** One log line, `[heap] key=value ...`, stable enough to grep and diff. */
export function formatHeapLine(r: HeapReport): string {
  const parts = [
    `heapUsed=${mb(r.memory.heapUsed)}`,
    `heapTotal=${mb(r.memory.heapTotal)}`,
    `rss=${mb(r.memory.rss)}`,
    `external=${mb(r.memory.external)}`,
    `arrayBuffers=${mb(r.memory.arrayBuffers)}`,
    `afterMajorGc=${r.afterMajorGc ? `${mb(r.afterMajorGc.heapUsed)}@${r.afterMajorGc.at}` : "none"}`,
    `majorGcs=${r.majorGcs}`,
  ]
  const handles = Object.entries(r.handles)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(",")
  parts.push(`handles=${handles || "none"}`)
  for (const [name, sizes] of Object.entries(r.structures)) {
    if ("error" in sizes && typeof sizes.error === "string") {
      parts.push(`${name}=error`)
      continue
    }
    const body = Object.entries(sizes as Record<string, number>)
      .map(([k, v]) => `${k}:${v}`)
      .join(",")
    parts.push(`${name}=${body || "none"}`)
  }
  return `[heap] ${parts.join(" ")}`
}

export function startHeapMonitor(opts: HeapMonitorOptions = {}): HeapMonitor {
  const probes = opts.probes ?? {}
  const memoryUsage = opts.memoryUsage ?? (() => process.memoryUsage())
  const activeResources = opts.activeResources ?? (() => process.getActiveResourcesInfo())
  const now = opts.now ?? (() => new Date())
  const log = opts.log ?? (line => console.log(line))
  let afterMajorGc: HeapReport["afterMajorGc"]
  let majorGcs = 0
  const unobserve = (opts.observeGc ?? defaultObserveGc)(() => {
    majorGcs++
    afterMajorGc = { heapUsed: memoryUsage().heapUsed, at: now().toISOString() }
  })

  const report = (): HeapReport => {
    const structures: HeapReport["structures"] = {}
    for (const [name, probe] of Object.entries(probes)) {
      try {
        structures[name] = probe()
      } catch (err) {
        structures[name] = { error: err instanceof Error ? err.message : String(err) }
      }
    }
    return {
      at: now().toISOString(),
      memory: memoryUsage(),
      ...(afterMajorGc ? { afterMajorGc: { ...afterMajorGc } } : {}),
      majorGcs,
      handles: groupHandles(activeResources()),
      structures,
    }
  }

  const intervalMs = opts.intervalMs ?? DEFAULT_HEAP_LOG_INTERVAL_MS
  let timer: ReturnType<typeof setInterval> | undefined
  if (intervalMs > 0) {
    timer = setInterval(() => {
      try {
        log(formatHeapLine(report()))
      } catch (err) {
        log(`[heap] report failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }, intervalMs)
    timer.unref?.()
  }

  return {
    report,
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
      unobserve()
    },
  }
}

export type HeapSnapshotResult =
  | { ok: true; path: string; heapUsed: number; freeBytes: number; durationMs: number; warning: string }
  | { ok: false; error: "insufficient_memory"; message: string; heapUsed: number; freeBytes: number; requiredBytes: number }
  | { ok: false; error: "snapshot_failed"; message: string }

export const HEAP_SNAPSHOT_WARNING =
  "v8.writeHeapSnapshot blocks the daemon's event loop until the file is written (seconds per GB of heap): " +
  "no request, session event or timer is served meanwhile, and the file is about the heap's size."

export function defaultHeapSnapshotDir(): string {
  return join(homedir(), ".agentproto", "heap-snapshots")
}

/** Where cgroup v2 exposes this process's memory controller. */
export const DEFAULT_CGROUP_DIR = "/sys/fs/cgroup"

function readCgroupBytes(path: string): number | undefined {
  try {
    const n = Number(readFileSync(path, "utf8").trim())
    return Number.isFinite(n) ? n : undefined
  } catch {
    return undefined
  }
}

/**
 * Memory this process can still use: `os.freemem()`, capped by the cgroup v2
 * room (`memory.max - memory.current`) when a limit is set. A container
 * capped well below the host would otherwise see the host's free memory and
 * approve a snapshot that gets it OOM-killed. No cgroup files, or
 * `memory.max` = `max`: host free memory alone.
 */
export function availableMemoryBytes(
  opts: { cgroupDir?: string; freeMemory?: () => number } = {},
): number {
  const free = (opts.freeMemory ?? freemem)()
  const dir = opts.cgroupDir ?? DEFAULT_CGROUP_DIR
  const max = readCgroupBytes(join(dir, "memory.max"))
  const current = readCgroupBytes(join(dir, "memory.current"))
  if (max === undefined || current === undefined) return free
  return Math.min(free, Math.max(0, max - current))
}

export interface HeapSnapshotDeps {
  dir?: string
  /** Overrides the whole available-memory read (cgroup included). */
  freeMemory?: () => number
  /** Host free memory fed to `availableMemoryBytes` (default `os.freemem`). */
  osFreeMemory?: () => number
  /** cgroup v2 directory read by `availableMemoryBytes`. */
  cgroupDir?: string
  memoryUsage?: () => NodeJS.MemoryUsage
  write?: (path: string) => string
  now?: () => Date
  headroomBytes?: number
}

/**
 * Write a heap snapshot of THIS process, unless available memory (host free
 * memory, capped by the cgroup limit) cannot hold it (`heapUsed + headroom`).
 * Synchronous: see `HEAP_SNAPSHOT_WARNING`.
 */
export function writeHeapSnapshotGuarded(deps: HeapSnapshotDeps = {}): HeapSnapshotResult {
  const freeBytes = deps.freeMemory
    ? deps.freeMemory()
    : availableMemoryBytes({
        ...(deps.cgroupDir !== undefined ? { cgroupDir: deps.cgroupDir } : {}),
        ...(deps.osFreeMemory ? { freeMemory: deps.osFreeMemory } : {}),
      })
  const heapUsed = (deps.memoryUsage ?? (() => process.memoryUsage()))().heapUsed
  const requiredBytes = heapUsed + (deps.headroomBytes ?? HEAP_SNAPSHOT_HEADROOM_BYTES)
  if (freeBytes < requiredBytes) {
    return {
      ok: false,
      error: "insufficient_memory",
      message:
        `refusing to write a heap snapshot: ${mb(freeBytes)} free, needs ${mb(requiredBytes)} ` +
        `(heapUsed ${mb(heapUsed)} + headroom); a snapshot this size would push the host into swap`,
      heapUsed,
      freeBytes,
      requiredBytes,
    }
  }
  try {
    const dir = deps.dir ?? defaultHeapSnapshotDir()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const at = (deps.now ?? (() => new Date()))()
    const file = join(dir, `heap-${at.toISOString().replace(/[:.]/g, "-")}-${process.pid}.heapsnapshot`)
    const started = Date.now()
    const path = (deps.write ?? writeHeapSnapshot)(file)
    return { ok: true, path, heapUsed, freeBytes, durationMs: Date.now() - started, warning: HEAP_SNAPSHOT_WARNING }
  } catch (err) {
    return { ok: false, error: "snapshot_failed", message: err instanceof Error ? err.message : String(err) }
  }
}
