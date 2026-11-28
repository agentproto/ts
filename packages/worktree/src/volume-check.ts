import { statfs, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"

const GiB = 1024 ** 3

/** Below this much free space on the system disk, new worktrees get a warning. */
export const LOW_FREE_BYTES = 50 * GiB
/** Or below this share of the disk. */
export const LOW_FREE_RATIO = 0.1

export interface VolumeProbes {
  /** Device id of an existing path. */
  deviceOf?: (path: string) => Promise<number>
  /** Paths whose device counts as "the system disk" (default: `/` and the home dir). */
  systemPaths?: readonly string[]
  /** Free and total bytes of the volume holding an existing path. */
  freeSpace?: (path: string) => Promise<{ freeBytes: number; totalBytes: number }>
}

async function defaultDeviceOf(path: string): Promise<number> {
  return (await stat(path)).dev
}

async function defaultFreeSpace(path: string): Promise<{ freeBytes: number; totalBytes: number }> {
  const s = await statfs(path)
  return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize }
}

async function nearestExisting(path: string, deviceOf: (p: string) => Promise<number>): Promise<string> {
  let current = resolve(path)
  for (;;) {
    try {
      await deviceOf(current)
      return current
    } catch (err) {
      const parent = dirname(current)
      if (parent === current) throw err
      current = parent
    }
  }
}

/**
 * A warning string when `root` (the worktrees root) is on the system disk and
 * that disk is short on space, otherwise `undefined`. Every worktree of a
 * dependency-heavy repo can take gigabytes, so a root left on a nearly full
 * system disk fills it. Never throws: any probe failure means "no warning".
 *
 * `root` may not exist yet; its nearest existing ancestor is probed.
 */
export async function checkWorktreesRootVolume(root: string, probes: VolumeProbes = {}): Promise<string | undefined> {
  const deviceOf = probes.deviceOf ?? defaultDeviceOf
  const freeSpace = probes.freeSpace ?? defaultFreeSpace
  const systemPaths = probes.systemPaths ?? ["/", homedir()]
  try {
    const probe = await nearestExisting(root, deviceOf)
    const rootDev = await deviceOf(probe)
    let onSystem = false
    for (const p of systemPaths) {
      if ((await deviceOf(p).catch(() => undefined)) === rootDev) {
        onSystem = true
        break
      }
    }
    if (!onSystem) return undefined
    const { freeBytes, totalBytes } = await freeSpace(probe)
    if (freeBytes >= LOW_FREE_BYTES && (totalBytes <= 0 || freeBytes / totalBytes >= LOW_FREE_RATIO)) return undefined
    const freeGiB = Math.round(freeBytes / GiB)
    return (
      `worktrees root ${root} is on the system disk, which has only about ${freeGiB} GiB free. ` +
      `Worktrees of dependency-heavy repos can take several GiB each. ` +
      `Point it at a larger volume: \`agentproto config set worktrees.root <dir>\` or set AGENTPROTO_WORKTREES_ROOT.`
    )
  } catch {
    return undefined
  }
}
