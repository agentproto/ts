/**
 * Driver-agnostic helpers built purely on `BatchDriver` — poll a submitted
 * batch to completion, then collect its results keyed by `customId`.
 */

import type { BatchDriver, BatchHandle, BatchResult, BatchStatus } from "./types.js"

const ONE_DAY_MS = 24 * 60 * 60 * 1000

export interface PollUntilEndedOptions {
  readonly intervalMs?: number
  readonly timeoutMs?: number
  readonly onTick?: (status: BatchStatus) => void
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Polls `driver.status(handle)` until it reaches a terminal state (`ended`
 *  or `failed`), calling `onTick` on every check. Throws if `timeoutMs`
 *  (default 24h, matching every provider's batch window) elapses first. */
export async function pollUntilEnded(
  driver: BatchDriver,
  handle: BatchHandle,
  opts: PollUntilEndedOptions = {},
): Promise<BatchStatus> {
  const intervalMs = opts.intervalMs ?? 30_000
  const timeoutMs = opts.timeoutMs ?? ONE_DAY_MS
  const deadline = Date.now() + timeoutMs

  for (;;) {
    const status = await driver.status(handle)
    opts.onTick?.(status)
    if (status.state === "ended" || status.state === "failed") return status
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(`batch "${handle.id}" did not reach a terminal state within ${timeoutMs}ms`)
    }
    await sleep(Math.min(intervalMs, remaining))
  }
}

/** Drains `driver.results(handle)` into a map keyed by `customId` — the only
 *  safe way to key results, since batch APIs return them in arbitrary order. */
export async function collectResults(
  driver: BatchDriver,
  handle: BatchHandle,
): Promise<Map<string, BatchResult>> {
  const byCustomId = new Map<string, BatchResult>()
  for await (const result of driver.results(handle)) {
    byCustomId.set(result.customId, result)
  }
  return byCustomId
}
