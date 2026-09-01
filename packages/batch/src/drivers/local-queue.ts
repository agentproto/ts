/**
 * Local-queue emulation for providers without a batch API (Requesty, Moonshot,
 * Groq, xAI, a local llm-endpoint…). Runs items through an injected `complete`
 * function with bounded concurrency and 429/5xx backoff, persisting each
 * result to the store as it lands. Full price, no discount — there is no
 * provider-side batch to get the 50% rate from.
 *
 * `submit()` runs every pending item to completion before resolving (there is
 * no external service to poll), so by the time it returns the batch is
 * already `ended`. `resume()` is the extra, driver-specific escape hatch for
 * continuing a handle whose process crashed mid-run: it reloads the original
 * requests from the store and only re-runs the ones still missing a result.
 */

import { newBatchId } from "../id.js"
import type { BatchStore } from "../store.js"
import {
  validateBatchRequests,
  BatchUnsupportedError,
  type AnthropicMessage,
  type BatchDriver,
  type BatchHandle,
  type BatchRequest,
  type BatchResult,
  type BatchResultError,
  type BatchSubmitOptions,
  type MessagesBody,
} from "../types.js"

/** Thrown by an injected `complete` function to signal a retryable failure
 *  (HTTP 429 or 5xx from the underlying provider). Any other thrown error is
 *  recorded as a permanent `errored` result for that item. */
export class RetryableCompletionError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = "RetryableCompletionError"
  }
}

export interface LocalQueueRetryOptions {
  readonly max?: number
  readonly backoffMs?: number
}

export interface LocalQueueDriverOptions {
  readonly complete: (body: MessagesBody) => Promise<AnthropicMessage>
  readonly concurrency?: number
  readonly store: BatchStore
  readonly retry?: LocalQueueRetryOptions
}

export interface LocalQueueDriver extends BatchDriver {
  /** Continue a handle whose prior run didn't finish (process crash, etc.) —
   *  reloads requests from the store and re-runs only the ones without a
   *  result yet. */
  resume(handle: BatchHandle): Promise<void>
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  async function runNext(): Promise<void> {
    const index = cursor
    cursor += 1
    const item = items[index]
    if (item === undefined) return
    await worker(item)
    await runNext()
  }
  const workerCount = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: workerCount }, () => runNext()))
}

function toResultError(err: unknown): BatchResultError {
  if (err instanceof Error) return { type: err.name, message: err.message }
  return { type: "Error", message: String(err) }
}

export function localQueueDriver(opts: LocalQueueDriverOptions): LocalQueueDriver {
  const concurrency = opts.concurrency ?? 4
  const maxRetries = opts.retry?.max ?? 3
  const backoffMs = opts.retry?.backoffMs ?? 1000
  const store = opts.store

  async function completeOne(request: BatchRequest): Promise<BatchResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        const message = await opts.complete(request.body)
        return { customId: request.customId, outcome: "succeeded", message }
      } catch (err) {
        if (err instanceof RetryableCompletionError && attempt < maxRetries) {
          await sleep(backoffMs * (attempt + 1))
          continue
        }
        return { customId: request.customId, outcome: "errored", error: toResultError(err) }
      }
    }
  }

  async function runPending(handle: BatchHandle, requests: readonly BatchRequest[]): Promise<void> {
    const record = await store.load(handle.id)
    const done = new Set((record?.results ?? []).map(result => result.customId))
    const pending = requests.filter(request => !done.has(request.customId))
    await runWithConcurrency(pending, concurrency, async request => {
      const result = await completeOne(request)
      await store.appendResults(handle.id, [result])
    })
  }

  return {
    id: "local-queue",

    async submit(
      requests: readonly BatchRequest[],
      submitOpts?: BatchSubmitOptions,
    ): Promise<BatchHandle> {
      validateBatchRequests(requests)
      const handle: BatchHandle = {
        id: newBatchId(),
        driver: "local-queue",
        provider: { batchIds: [] },
        createdAt: new Date().toISOString(),
        requestCount: requests.length,
        models: Array.from(new Set(requests.map(request => request.body.model))),
      }
      await store.create(handle, requests, submitOpts)
      await runPending(handle, requests)
      return handle
    },

    async status(handle: BatchHandle) {
      const record = await store.load(handle.id)
      const results = record?.results ?? []
      const succeeded = results.filter(r => r.outcome === "succeeded").length
      const errored = results.filter(r => r.outcome === "errored").length
      const canceled = results.filter(r => r.outcome === "canceled").length
      const expired = results.filter(r => r.outcome === "expired").length
      const processing = Math.max(0, handle.requestCount - results.length)
      return {
        state: processing > 0 ? ("in_progress" as const) : ("ended" as const),
        counts: { processing, succeeded, errored, canceled, expired },
      }
    },

    async *results(handle: BatchHandle): AsyncIterable<BatchResult> {
      const record = await store.load(handle.id)
      for (const result of record?.results ?? []) yield result
    },

    async cancel(handle: BatchHandle): Promise<void> {
      const record = await store.load(handle.id)
      if (!record) throw new BatchUnsupportedError("cancel", "local-queue")
      const done = new Set(record.results.map(result => result.customId))
      const canceled: BatchResult[] = record.requests
        .filter(request => !done.has(request.customId))
        .map(request => ({ customId: request.customId, outcome: "canceled" as const }))
      await store.appendResults(handle.id, canceled)
    },

    async resume(handle: BatchHandle): Promise<void> {
      const record = await store.load(handle.id)
      if (!record) throw new Error(`unknown batch "${handle.id}"`)
      await runPending(handle, record.requests)
    },
  }
}
