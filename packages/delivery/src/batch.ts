/**
 * Per-target coalescing for the delivery kernel.
 *
 * A producer that can emit several envelopes for one target in a short burst
 * uses this to hold them for `batchMs` and hand the whole burst to one flush
 * call. One flush is one delivery, so a session sees one turn instead of one
 * turn per envelope. A `batchMs` of 0 (or less) delivers each item immediately,
 * which keeps the pre-batching behaviour when a producer opts in gradually.
 *
 * Pure apart from the injectable timer functions: the producer owns what a
 * flush means (which transport, how to render a digest, how to record the
 * ledger). This module only owns the per-target window and the flush order.
 */

/** Timer hooks, injectable so vitest fake timers and a runtime clock apply. */
export interface DeliveryBatchTimers {
  /** Defaults to the global `setTimeout`, resolved at call time. */
  setTimer?: (fn: () => void, ms: number) => unknown
  /** Defaults to the global `clearTimeout`, resolved at call time. */
  clearTimer?: (handle: unknown) => void
}

export interface DeliveryBatcherOptions<T> extends DeliveryBatchTimers {
  /** Deliver one target's collected items in a single call. A throw means the
   *  flush failed; the batch is still dropped and the producer is told via
   *  {@link DeliveryBatcherOptions.onError}. */
  flush: (target: string, items: readonly T[]) => void | Promise<void>
  /** Called when a flush throws. Never changes the outcome of `enqueue`. */
  onError?: (target: string, items: readonly T[], error: unknown) => void
}

export interface DeliveryBatcher<T> {
  /**
   * Add `item` to `target`'s batch. The first item opens a window of
   * `batchMs` milliseconds; later items inside it join the same window. The
   * returned promise settles once that window's flush attempt has finished.
   * `batchMs <= 0` delivers the item immediately (one flush per item).
   */
  enqueue(target: string, batchMs: number, item: T): Promise<void>
  /** Flush one target now, or every target when omitted. Resolves after the
   *  flushes started by this call settled. */
  flush(target?: string): Promise<void>
  /** Drop every pending batch without delivering it (shutdown). */
  dispose(): void
  /** Targets that currently have an open window, in insertion order. */
  pending(): readonly string[]
}

interface BatchGroup<T> {
  target: string
  batchMs: number
  items: T[]
  timer: unknown
  waiters: Array<() => void>
}

export function createDeliveryBatcher<T>(opts: DeliveryBatcherOptions<T>): DeliveryBatcher<T> {
  const setTimer =
    opts.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms))
  const clearTimer =
    opts.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>))

  const groups = new Map<string, BatchGroup<T>>()
  const inFlight = new Set<Promise<void>>()

  function run(target: string, items: readonly T[]): Promise<void> {
    let result: void | Promise<void>
    try {
      result = opts.flush(target, items)
    } catch (err) {
      opts.onError?.(target, items, err)
      return Promise.resolve()
    }
    return Promise.resolve(result).catch(err => {
      opts.onError?.(target, items, err)
    })
  }

  function startFlush(target: string, items: readonly T[]): Promise<void> {
    const promise = run(target, items)
    inFlight.add(promise)
    void promise.finally(() => inFlight.delete(promise))
    return promise
  }

  function flushGroup(group: BatchGroup<T>): Promise<void> {
    if (groups.get(group.target) === group) groups.delete(group.target)
    if (group.timer !== undefined) clearTimer(group.timer)
    group.timer = undefined
    const promise = startFlush(group.target, group.items)
    void promise.finally(() => {
      for (const resolve of group.waiters) resolve()
      group.waiters = []
    })
    return promise
  }

  function enqueue(target: string, batchMs: number, item: T): Promise<void> {
    if (!(batchMs > 0)) return startFlush(target, [item])

    let group = groups.get(target)
    if (!group) {
      group = { target, batchMs, items: [], timer: undefined, waiters: [] }
      groups.set(target, group)
    }
    const current = group
    current.items.push(item)
    const settled = new Promise<void>(resolve => current.waiters.push(resolve))
    if (current.timer === undefined) {
      current.timer = setTimer(() => {
        void flushGroup(current)
      }, current.batchMs)
      // A pending coalescing window must not hold the process open.
      ;(current.timer as { unref?: () => void } | undefined)?.unref?.()
    }
    return settled
  }

  async function flush(target?: string): Promise<void> {
    if (target !== undefined) {
      const group = groups.get(target)
      if (group) await flushGroup(group)
    } else {
      const pending = [...groups.values()]
      await Promise.all(pending.map(group => flushGroup(group)))
    }
    await Promise.all([...inFlight])
  }

  function dispose(): void {
    for (const group of groups.values()) {
      if (group.timer !== undefined) clearTimer(group.timer)
      group.timer = undefined
      for (const resolve of group.waiters) resolve()
      group.waiters = []
    }
    groups.clear()
  }

  return {
    enqueue,
    flush,
    dispose,
    pending: () => [...groups.keys()],
  }
}
