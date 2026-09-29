import { execFile } from "node:child_process"

export interface ProcessEntry {
  pid: number
  command: string
}

/** Injected process access. Real code uses `ps`; tests hand in a fixed list. */
export type ProcessLister = () => Promise<ProcessEntry[]>
export type ProcessKiller = (pid: number, signal: NodeJS.Signals) => void

/** Argv token that ties a browser process to one instance (the sweep key). */
export function browserInstanceMarker(instanceKey: string): string {
  return `--agentproto-browser=${instanceKey}`
}

/** Exact-token match, so instance `a1` never matches `a10`'s marker. */
export function commandHasMarker(command: string, marker: string): boolean {
  let i = command.indexOf(marker)
  while (i >= 0) {
    const next = command[i + marker.length]
    if (next === undefined || next === " ") return true
    i = command.indexOf(marker, i + 1)
  }
  return false
}

/** Default lister: `ps -axo pid=,command=`. Resolves to `[]` when `ps` fails. */
export const psListProcesses: ProcessLister = () =>
  new Promise((resolve) => {
    execFile(
      "ps",
      ["-axo", "pid=,command="],
      { maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve([])
        const out: ProcessEntry[] = []
        for (const line of stdout.split("\n")) {
          const m = line.match(/^\s*(\d+)\s+(.*)$/)
          if (m) out.push({ pid: Number(m[1]), command: m[2] ?? "" })
        }
        resolve(out)
      },
    )
  })

export interface OrphanSweepOptions {
  marker: string
  listProcesses?: ProcessLister
  kill?: ProcessKiller
  /** Pids that must never be signalled (default: this process). */
  protectPids?: readonly number[]
  signal?: NodeJS.Signals
}

/**
 * Kill only processes whose command carries `marker`. Never matches by name,
 * so an unrelated browser the user runs is untouched. Returns the pids
 * signalled.
 */
export async function sweepOrphans(opts: OrphanSweepOptions): Promise<number[]> {
  if (opts.marker.length === 0) return []
  const list = opts.listProcesses ?? psListProcesses
  const kill = opts.kill ?? ((pid, sig) => process.kill(pid, sig))
  const protect = new Set<number>([process.pid, ...(opts.protectPids ?? [])])
  const signalled: number[] = []
  for (const p of await list()) {
    if (protect.has(p.pid) || !commandHasMarker(p.command, opts.marker)) continue
    try {
      kill(p.pid, opts.signal ?? "SIGKILL")
      signalled.push(p.pid)
    } catch {
      // already gone
    }
  }
  return signalled
}
