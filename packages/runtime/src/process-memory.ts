/**
 * Per-session RAM (process tree RSS) — the runtime's only source of "how much
 * memory is this session actually holding", used by the session steward
 * (`session-wrapup.ts`) to weigh a candidate before closing it.
 *
 * ONE `ps -A -o pid=,ppid=,rss=` call answers for every root pid at once
 * (`rss` is KiB on both macOS and Linux) — the parent→children map it builds
 * is then walked per root to sum the whole subtree, so N sessions cost one
 * process spawn, not N.
 */

import { execFile } from "node:child_process"

/** Injectable so a test can hand back canned `ps` output without spawning a
 *  real process. Rejects on any failure (Windows has no `ps`, the binary may
 *  be missing, …) — {@link processTreeRss} treats a rejection as "no data",
 *  never as a reason to throw. */
export type PsExecutor = () => Promise<string>

const defaultPsExecutor: PsExecutor = () =>
  new Promise((resolve, reject) => {
    if (process.platform === "win32") {
      reject(new Error("processTreeRss: ps is not available on win32"))
      return
    }
    execFile(
      "ps",
      ["-A", "-o", "pid=,ppid=,rss="],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout)
      },
    )
  })

interface PsRow {
  pid: number
  ppid: number
  rssKib: number
}

function parsePsOutput(output: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of output.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 3) continue
    const pid = Number(parts[0])
    const ppid = Number(parts[1])
    const rssKib = Number(parts[2])
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(rssKib)) continue
    rows.push({ pid, ppid, rssKib })
  }
  return rows
}

/**
 * Summed RSS in BYTES of each root pid and all its descendants, one entry
 * per root pid that `ps` actually reported (a root pid absent from `ps`'s
 * output — already dead, or an id `ps` never knew about — is simply absent
 * from the returned map rather than reported as 0, since "no data" and
 * "measured zero" are different claims).
 *
 * Never throws: a `ps` spawn failure (Windows, a missing binary, a sandbox
 * that blocks `ps`) resolves to an empty map.
 */
export async function processTreeRss(
  rootPids: readonly number[],
  exec: PsExecutor = defaultPsExecutor,
): Promise<Map<number, number>> {
  if (rootPids.length === 0) return new Map()

  let output: string
  try {
    output = await exec()
  } catch {
    return new Map()
  }

  const rows = parsePsOutput(output)
  const rssByPid = new Map<number, number>()
  const childrenByParent = new Map<number, number[]>()
  for (const row of rows) {
    rssByPid.set(row.pid, row.rssKib)
    const siblings = childrenByParent.get(row.ppid)
    if (siblings) siblings.push(row.pid)
    else childrenByParent.set(row.ppid, [row.pid])
  }

  const result = new Map<number, number>()
  for (const root of rootPids) {
    if (!rssByPid.has(root)) continue
    let totalKib = 0
    const stack = [root]
    const visited = new Set<number>()
    while (stack.length > 0) {
      const pid = stack.pop()!
      if (visited.has(pid)) continue
      visited.add(pid)
      totalKib += rssByPid.get(pid) ?? 0
      for (const child of childrenByParent.get(pid) ?? []) stack.push(child)
    }
    result.set(root, totalKib * 1024)
  }
  return result
}
