/**
 * OpenRouter Batch API driver (beta, openrouter.ai/docs/batch-quickstart).
 * One provider batch is scoped to a single model, so a submit fans out to N
 * provider batches — one per distinct `body.model` in the request set.
 * Ground truth (verified 2026-09-01):
 *
 *   POST https://openrouter.ai/api/beta/batches
 *     body field ORDER MATTERS (stream-parsed): { endpoint, model, requests }
 *   GET  https://openrouter.ai/api/beta/batches/:id
 *     status: validating | in_progress | finalizing | completed | failed | expired | cancelled
 *     when completed: results: [{ custom_id, response?, error? }] inline (no results endpoint)
 *
 * Cancel is undocumented — `cancel()` throws `BatchUnsupportedError` rather
 * than pretend it worked.
 */

import { z } from "zod"
import { newBatchId } from "../id.js"
import {
  anthropicMessageSchema,
  validateBatchRequests,
  BatchUnsupportedError,
  type BatchCounts,
  type BatchDriver,
  type BatchHandle,
  type BatchOutcome,
  type BatchRequest,
  type BatchResult,
  type BatchState,
  type BatchSubmitOptions,
} from "../types.js"

const openrouterStatusSchema = z.enum([
  "validating",
  "in_progress",
  "finalizing",
  "completed",
  "failed",
  "expired",
  "cancelled",
])

type OpenrouterStatus = z.infer<typeof openrouterStatusSchema>

const openrouterResultEntrySchema = z
  .object({
    custom_id: z.string(),
    response: anthropicMessageSchema.optional(),
    error: z.object({ type: z.string(), message: z.string() }).loose().optional(),
  })
  .loose()

const openrouterBatchObjectSchema = z
  .object({
    id: z.string(),
    status: openrouterStatusSchema,
    results: z.array(openrouterResultEntrySchema).optional(),
  })
  .loose()

type OpenrouterBatchObject = z.infer<typeof openrouterBatchObjectSchema>

export interface OpenrouterBatchDriverOptions {
  readonly apiKey: string
  readonly baseUrl?: string
  readonly fetch?: typeof fetch
}

interface OpenrouterGroup {
  readonly model: string
  readonly batchId: string
  readonly customIds: readonly string[]
}

function groupByModel(requests: readonly BatchRequest[]): Map<string, BatchRequest[]> {
  const groups = new Map<string, BatchRequest[]>()
  for (const request of requests) {
    const existing = groups.get(request.body.model)
    if (existing) existing.push(request)
    else groups.set(request.body.model, [request])
  }
  return groups
}

const STATE_SEVERITY: Record<BatchState, number> = {
  failed: 4,
  canceling: 3,
  in_progress: 2,
  queued: 1,
  ended: 0,
}

function worseState(a: BatchState, b: BatchState): BatchState {
  return STATE_SEVERITY[a] >= STATE_SEVERITY[b] ? a : b
}

function mapOpenrouterState(status: OpenrouterStatus): BatchState {
  switch (status) {
    case "validating":
    case "in_progress":
    case "finalizing":
      return "in_progress"
    case "failed":
      return "failed"
    case "completed":
    case "expired":
    case "cancelled":
      return "ended"
  }
}

/** Per-batch counts. When a size is known (same-process cache hit) a batch
 *  that hasn't produced inline `results` yet is counted as fully processing;
 *  a terminal-without-results batch (expired/cancelled/failed) is counted as
 *  that outcome for its whole group. Without a known size (cross-process
 *  re-attach with no cache), everything but a `completed` batch reports zero
 *  here — `status()` reconciles the shortfall against the handle's total. */
function countsForBatch(batch: OpenrouterBatchObject, size: number | undefined): BatchCounts {
  const counts: BatchCounts = { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 }
  if (batch.results) {
    for (const entry of batch.results) {
      if (entry.response) counts.succeeded += 1
      else counts.errored += 1
    }
    return counts
  }
  if (size === undefined) return counts
  switch (batch.status) {
    case "expired":
      counts.expired = size
      break
    case "cancelled":
      counts.canceled = size
      break
    case "failed":
      counts.errored = size
      break
    default:
      counts.processing = size
  }
  return counts
}

export function openrouterBatchDriver(opts: OpenrouterBatchDriverOptions): BatchDriver {
  const baseUrl = (opts.baseUrl ?? "https://openrouter.ai/api/beta").replace(/\/+$/, "")
  const doFetch = opts.fetch ?? fetch
  const groupsByHandle = new Map<string, readonly OpenrouterGroup[]>()

  function headers(): Record<string, string> {
    return {
      authorization: `Bearer ${opts.apiKey}`,
      "content-type": "application/json",
    }
  }

  async function fetchBatch(batchId: string): Promise<OpenrouterBatchObject> {
    const res = await doFetch(`${baseUrl}/batches/${batchId}`, { headers: headers() })
    if (!res.ok) {
      throw new Error(`openrouter batch status ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    return openrouterBatchObjectSchema.parse(await res.json())
  }

  return {
    id: "openrouter",

    async submit(
      requests: readonly BatchRequest[],
      _submitOpts?: BatchSubmitOptions,
    ): Promise<BatchHandle> {
      validateBatchRequests(requests)
      const grouped = groupByModel(requests)
      const groups: OpenrouterGroup[] = []

      for (const [model, groupRequests] of grouped) {
        const res = await doFetch(`${baseUrl}/batches`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({
            endpoint: "/v1/messages",
            model,
            requests: groupRequests.map(request => ({
              custom_id: request.customId,
              body: request.body,
            })),
          }),
        })
        if (!res.ok) {
          throw new Error(
            `openrouter batch submit ${res.status}: ${(await res.text()).slice(0, 200)}`,
          )
        }
        const batch = openrouterBatchObjectSchema.parse(await res.json())
        groups.push({
          model,
          batchId: batch.id,
          customIds: groupRequests.map(request => request.customId),
        })
      }

      const handle: BatchHandle = {
        id: newBatchId(),
        driver: "openrouter",
        provider: { batchIds: groups.map(g => g.batchId) },
        createdAt: new Date().toISOString(),
        requestCount: requests.length,
        models: groups.map(g => g.model),
      }
      groupsByHandle.set(handle.id, groups)
      return handle
    },

    async status(handle: BatchHandle) {
      const cachedGroups = groupsByHandle.get(handle.id)
      const batches = await Promise.all(handle.provider.batchIds.map(id => fetchBatch(id)))

      const counts: BatchCounts = { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 }
      let state: BatchState = "ended"
      for (const [index, batch] of batches.entries()) {
        const size = cachedGroups?.[index]?.customIds.length
        const batchCounts = countsForBatch(batch, size)
        counts.processing += batchCounts.processing
        counts.succeeded += batchCounts.succeeded
        counts.errored += batchCounts.errored
        counts.canceled += batchCounts.canceled
        counts.expired += batchCounts.expired
        state = worseState(state, mapOpenrouterState(batch.status))
      }

      if (!cachedGroups) {
        const accounted = counts.succeeded + counts.errored + counts.canceled + counts.expired
        counts.processing = Math.max(0, handle.requestCount - accounted)
      }

      return {
        state,
        counts,
        providerStatus: batches.map(b => b.status).join(","),
      }
    },

    async *results(handle: BatchHandle): AsyncIterable<BatchResult> {
      const cachedGroups = groupsByHandle.get(handle.id)
      for (const [index, batchId] of handle.provider.batchIds.entries()) {
        const batch = await fetchBatch(batchId)
        if (batch.results) {
          for (const entry of batch.results) {
            const outcome: BatchOutcome = entry.response ? "succeeded" : "errored"
            yield { customId: entry.custom_id, outcome, message: entry.response, error: entry.error }
          }
          continue
        }
        const customIds = cachedGroups?.[index]?.customIds
        if (!customIds) continue
        const outcome: BatchOutcome =
          batch.status === "expired" ? "expired" : batch.status === "cancelled" ? "canceled" : "errored"
        for (const customId of customIds) {
          yield { customId, outcome }
        }
      }
    },

    async cancel(): Promise<void> {
      throw new BatchUnsupportedError("cancel", "openrouter")
    },
  }
}
