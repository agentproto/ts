/**
 * Whole-tree teardown for a spawned adapter process.
 *
 * `child.kill("SIGTERM")` alone signals only the direct child — for most
 * adapters that is an `npx`/`npm exec` wrapper, and the wrapper can ignore
 * SIGTERM (observed live) while the real adapter, its MCP servers, and any
 * headless Chrome they started keep running as its descendants. Worse, once
 * the wrapper does die those descendants reparent to init and are no longer
 * findable from the child's pid at all.
 *
 * So the tree is snapshotted (`ps -axo pid=,ppid=`) BEFORE anything is
 * signalled, every member gets SIGTERM, and whatever is still alive after a
 * grace period — plus anything it spawned meanwhile — gets SIGKILL.
 */

import { execFile, type ChildProcess } from "node:child_process"

export interface ProcessRow {
  pid: number
  ppid: number
}

export interface TerminateTreeOptions {
  /** How long SIGTERM gets before survivors are SIGKILLed. Default 3000ms. */
  graceMs?: number
  /** Liveness poll interval during the grace period. Default 100ms. */
  pollMs?: number
  /** Process table source — injectable for tests. Default `ps -axo pid=,ppid=`. */
  listProcesses?: () => Promise<ProcessRow[]>
}

export interface TerminateTreeResult {
  /** Descendant pids found in the pre-signal snapshot (root excluded). */
  descendants: number[]
  /** Pids (root included) still alive after the grace period, SIGKILLed. */
  killed: number[]
}

const DEFAULT_GRACE_MS = 3000
const DEFAULT_POLL_MS = 100

/** Every pid below `rootPid` in `rows` (breadth-first, root excluded). */
export function descendantsOf(rootPid: number, rows: readonly ProcessRow[]): number[] {
  const byParent = new Map<number, number[]>()
  for (const r of rows) {
    const list = byParent.get(r.ppid)
    if (list) list.push(r.pid)
    else byParent.set(r.ppid, [r.pid])
  }
  const out: number[] = []
  const seen = new Set<number>([rootPid])
  const queue = [rootPid]
  while (queue.length > 0) {
    const pid = queue.shift() as number
    for (const kid of byParent.get(pid) ?? []) {
      if (seen.has(kid)) continue
      seen.add(kid)
      out.push(kid)
      queue.push(kid)
    }
  }
  return out
}

/**
 * SIGTERM `child` and its whole process tree, then SIGKILL whatever survives
 * `graceMs`. Resolves once the tree is gone or the SIGKILLs are sent.
 *
 * The root is signalled through `child.kill()` and its liveness read off
 * `exitCode`/`signalCode`, never a raw `process.kill(child.pid)` — a child
 * whose spawn failed has no pid to signal (see the runtime's
 * `killChildIfSpawned`), and a root that already exited is a no-op, so this
 * never touches a pid it didn't verifiably spawn and still own.
 */
export async function terminateChildTree(
  child: ChildProcess,
  opts: TerminateTreeOptions = {},
): Promise<TerminateTreeResult> {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const list = opts.listProcesses ?? listProcesses
  const rootPid = child.pid
  const rootAlive = (): boolean => child.exitCode === null && child.signalCode === null
  if (typeof rootPid !== "number" || rootPid <= 0 || rootPid === process.pid || !rootAlive()) {
    return { descendants: [], killed: [] }
  }

  // Snapshot first: after the root dies its descendants reparent to init.
  const descendants = descendantsOf(rootPid, await list()).filter(p => p !== process.pid)
  const tracked = new Set(descendants)

  try {
    child.kill("SIGTERM")
  } catch {
    // already gone
  }
  for (const pid of tracked) signal(pid, "SIGTERM")

  const anyAlive = (): boolean => rootAlive() || [...tracked].some(isAlive)
  const deadline = Date.now() + graceMs
  while (anyAlive() && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs))
  }
  if (!anyAlive()) return { descendants, killed: [] }

  // Anything a survivor spawned during the grace period belongs to the tree
  // too — re-walk from the root (if still alive) and from every survivor.
  const rows = await list()
  const survivors = [...tracked].filter(isAlive)
  for (const from of rootAlive() ? [rootPid, ...survivors] : survivors) {
    for (const pid of descendantsOf(from, rows)) {
      if (pid !== process.pid) tracked.add(pid)
    }
  }

  const killed: number[] = []
  if (rootAlive()) {
    try {
      child.kill("SIGKILL")
      killed.push(rootPid)
    } catch {
      // already gone
    }
  }
  for (const pid of tracked) {
    if (isAlive(pid) && signal(pid, "SIGKILL")) killed.push(pid)
  }
  return { descendants, killed }
}

function signal(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig)
    return true
  } catch {
    return false
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: exists, just not ours to signal-probe.
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** `ps` is absent on Windows — resolve empty, degrading to root-only. */
function listProcesses(): Promise<ProcessRow[]> {
  return new Promise(resolve => {
    execFile("ps", ["-axo", "pid=,ppid="], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([])
      const out: ProcessRow[] = []
      for (const line of stdout.split("\n")) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s*$/)
        if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]) })
      }
      resolve(out)
    })
  })
}
