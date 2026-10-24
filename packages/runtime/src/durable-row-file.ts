/**
 * DurableRowFile: a small durable, keyed-row store shared by the sentinel
 * webhook outbox and the reaction receipt store. It knows nothing about
 * sentinels, events or deliveries: callers supply the key, the row shape and
 * the loader filter.
 *
 * The rows live in a Map; the persisted form is a pretty-printed JSON object
 * keyed by row key with a trailing newline, written via the crash-durable
 * tmp/fsync/rename path in `durable-file.ts`. Async writes ride one serialized
 * chain so a slow older snapshot can never land after a newer one.
 */

import { readFileSync } from "node:fs"

import { writeFileDurable, writeFileDurableSync } from "./durable-file.js"

export interface DurableRowFileOptions<Row> {
  filePath: string
  /** false: nothing touches disk. */
  persist: boolean
  debounceMs: number
  log: (line: string) => void
  /** Used verbatim in every log line, for example "[sentinel-webhook-outbox]". */
  logPrefix: string
  /** Rebuild a row (and its key) from a parsed value. Return undefined to drop it. */
  acceptLoaded: (value: unknown) => readonly [key: string, row: Row] | undefined
}

export interface DurableRowFile<Row> {
  readonly rows: Map<string, Row>
  /** Serialized chain plus generation guard, durable before it resolves. */
  persistNow(): Promise<void>
  /** Debounced, best effort; logs `<prefix> persist failed: ...` on failure. */
  schedulePersist(): void
  /** Awaits the current tail of the write chain. */
  settled(): Promise<void>
  /** Shutdown path, never throws. */
  flushSync(): void
  insertDurable(
    key: string,
    row: Row,
    retention: { cap: number; oldestTerminalKey: () => string | undefined },
  ): Promise<void>
}

/** Key of the terminal row with the smallest terminalAt, or undefined. */
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
  /** Bumped by flushSync so an in-flight async write that started earlier
   *  cannot rename an older snapshot over the newer synchronous one. */
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
      // Not durable means not accepted: roll back so nothing acts on a row
      // the disk does not hold.
      if (rows.get(key) === row) rows.delete(key)
      if (evicted && !rows.has(evicted[0])) rows.set(evicted[0], evicted[1])
      throw err
    }
  }

  return { rows, persistNow, schedulePersist, settled, flushSync, insertDurable }
}
