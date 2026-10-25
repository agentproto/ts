/** Self-contained crash-durable file helpers for the sentinel store family.
 *  The daemon passes its own implementations through the platform port; these
 *  are the standalone defaults (same tmp -> fsync -> rename -> dir-fsync
 *  contract). */

import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
  promises as fsp,
} from "node:fs"
import { dirname } from "node:path"

let tmpSeq = 0
const tmpPathFor = (filePath: string): string => `${filePath}.tmp.${process.pid}.${++tmpSeq}`

function isDirSyncUnsupported(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code === "EINVAL" || code === "EPERM" || code === "EISDIR" || code === "ENOTSUP"
}

export interface WriteFileDurableOptions {
  mode?: number
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

export interface DurableRowFileOptions<Row> {
  filePath: string
  persist: boolean
  debounceMs: number
  log: (line: string) => void
  logPrefix: string
  acceptLoaded: (value: unknown) => readonly [key: string, row: Row] | undefined
}

export interface DurableRowFile<Row> {
  readonly rows: Map<string, Row>
  persistNow(): Promise<void>
  schedulePersist(): void
  settled(): Promise<void>
  flushSync(): void
  insertDurable(
    key: string,
    row: Row,
    retention: { cap: number; oldestTerminalKey: () => string | undefined },
  ): Promise<void>
}

export function oldestTerminalKey<Row>(
  rows: ReadonlyMap<string, Row>,
  isTerminal: (row: Row) => boolean,
  terminalAt: (row: Row) => number,
): string | undefined {
  const oldest = [...rows.entries()]
    .filter(([, row]) => isTerminal(row))
    .sort(([, a], [, b]) => terminalAt(a) - terminalAt(b))
    .at(0)
  return oldest ? oldest[0] : undefined
}

export function createDurableRowFile<Row>(opts: DurableRowFileOptions<Row>): DurableRowFile<Row> {
  const { filePath, persist, debounceMs, log, logPrefix } = opts

  const load = (): Map<string, Row> => {
    const out = new Map<string, Row>()
    if (!persist) return out
    let raw: string
    try {
      raw = readFileSync(filePath, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log(`${logPrefix} read failed, starting empty: ${err instanceof Error ? err.message : String(err)}`)
      }
      return out
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      for (const value of Object.values(parsed)) {
        const accepted = opts.acceptLoaded(value)
        if (accepted) out.set(accepted[0], accepted[1])
      }
    } catch (err) {
      log(`${logPrefix} corrupt file, starting empty: ${err instanceof Error ? err.message : String(err)}`)
    }
    return out
  }

  const rows = load()

  const snapshot = (): Record<string, Row> => {
    const out: Record<string, Row> = {}
    for (const [key, row] of rows.entries()) out[key] = row
    return out
  }

  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let writeTail: Promise<void> = Promise.resolve()
  let syncGeneration = 0

  const persistNow = (): Promise<void> => {
    if (!persist) return Promise.resolve()
    const run = async (): Promise<void> => {
      const generation = syncGeneration
      const body = JSON.stringify(snapshot(), null, 2) + "\n"
      await writeFileDurable(filePath, body, { commitIf: () => generation === syncGeneration })
    }
    const next = writeTail.then(run, run)
    writeTail = next.catch(() => undefined)
    return next
  }

  const schedulePersist = (): void => {
    if (!persist) return
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      persistNow().catch(err => {
        log(`${logPrefix} persist failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }, debounceMs)
  }

  const flushSync = (): void => {
    if (!persist) return
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    syncGeneration++
    try {
      writeFileDurableSync(filePath, JSON.stringify(snapshot(), null, 2) + "\n")
    } catch {
      // best-effort, never throw in the shutdown path
    }
  }

  const settled = (): Promise<void> => writeTail

  const insertDurable = async (
    key: string,
    row: Row,
    retention: { cap: number; oldestTerminalKey: () => string | undefined },
  ): Promise<void> => {
    let evicted: [string, Row] | undefined
    if (rows.size >= retention.cap) {
      const oldest = retention.oldestTerminalKey()
      const evictedRow = oldest ? rows.get(oldest) : undefined
      if (oldest && evictedRow !== undefined) {
        evicted = [oldest, evictedRow]
        rows.delete(oldest)
      }
    }

    rows.set(key, row)
    try {
      await persistNow()
    } catch (err) {
      if (rows.get(key) === row) rows.delete(key)
      if (evicted && !rows.has(evicted[0])) rows.set(evicted[0], evicted[1])
      throw err
    }
  }

  return { rows, persistNow, schedulePersist, settled, flushSync, insertDurable }
}
