/**
 * Crash-durable file writes: tmp file → fsync → rename → fsync of the parent
 * directory. When the returned promise resolves, the bytes survive a process
 * crash AND a power loss; when it rejects, the target is untouched (old
 * content or absent). Used by stores that acknowledge an upstream only after
 * their own write is durable (webhook outbox, cancel tombstones, quarantine).
 */

import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
  promises as fsp,
} from "node:fs"
import { dirname } from "node:path"

let tmpSeq = 0

const tmpPathFor = (filePath: string): string => `${filePath}.tmp.${process.pid}.${++tmpSeq}`

/** Directory fsync is unsupported on some platforms/filesystems (Windows);
 *  those report EINVAL/EPERM/EISDIR and the rename itself is the best
 *  available guarantee there. */
function isDirSyncUnsupported(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code === "EINVAL" || code === "EPERM" || code === "EISDIR" || code === "ENOTSUP"
}

export interface WriteFileDurableOptions {
  mode?: number
  /** Checked right before the rename; `false` abandons the write (the tmp is
   *  removed, the target untouched) — lets a newer synchronous flush win. */
  commitIf?: () => boolean
}

export async function writeFileDurable(filePath: string, data: string, opts: WriteFileDurableOptions = {}): Promise<void> {
  const mode = opts.mode ?? 0o600
  const dir = dirname(filePath)
  await fsp.mkdir(dir, { recursive: true })
  const tmp = tmpPathFor(filePath)
  try {
    const fh = await fsp.open(tmp, "w", mode)
    try {
      await fh.writeFile(data)
      await fh.chmod(mode)
      await fh.sync()
    } finally {
      await fh.close()
    }
    if (opts.commitIf && !opts.commitIf()) {
      await fsp.unlink(tmp).catch(() => undefined)
      return
    }
    await fsp.rename(tmp, filePath)
  } catch (err) {
    await fsp.unlink(tmp).catch(() => undefined)
    throw err
  }
  try {
    const dh = await fsp.open(dir, "r")
    try {
      await dh.sync()
    } finally {
      await dh.close()
    }
  } catch (err) {
    if (!isDirSyncUnsupported(err)) throw err
  }
}

export function writeFileDurableSync(filePath: string, data: string, mode = 0o600): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const tmp = tmpPathFor(filePath)
  try {
    const fd = openSync(tmp, "w", mode)
    try {
      writeSync(fd, data)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, filePath)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // tmp may not exist
    }
    throw err
  }
  try {
    const dfd = openSync(dir, "r")
    try {
      fsyncSync(dfd)
    } finally {
      closeSync(dfd)
    }
  } catch (err) {
    if (!isDirSyncUnsupported(err)) throw err
  }
}

/** Append one line and fsync before returning (throws on failure). */
export function appendLineDurableSync(filePath: string, line: string, mode = 0o600): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const existed = (() => {
    try {
      closeSync(openSync(filePath, "r"))
      return true
    } catch {
      return false
    }
  })()
  const fd = openSync(filePath, "a", mode)
  try {
    appendFileSync(fd, line.endsWith("\n") ? line : `${line}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  if (!existed) {
    try {
      const dfd = openSync(dirname(filePath), "r")
      try {
        fsyncSync(dfd)
      } finally {
        closeSync(dfd)
      }
    } catch (err) {
      if (!isDirSyncUnsupported(err)) throw err
    }
  }
}
