/**
 * Anthropic Message Batches driver — one provider batch per submit. Hand-rolled
 * over the HTTP API (no SDK dep), mirroring the other raw-fetch ports in this
 * repo. Ground truth (verified 2026-09-01, platform.claude.com/docs/en/build-with-claude/batch-processing):
 *
 *   POST   /v1/messages/batches            { requests: [{ custom_id, params }] }
 *   GET    /v1/messages/batches/{id}       processing_status, request_counts, results_url
 *   GET    /v1/messages/batches/{id}/results   JSONL, one result per line, ANY ORDER
 *   POST   /v1/messages/batches/{id}/cancel
 *
 * Limits: 100k requests / 256MB per batch, 24h window, results kept 29 days.
 */

import { z } from "zod"
import { newBatchId } from "../id.js"
import {
  anthropicMessageSchema,
  batchOutcomeSchema,
  validateBatchRequests,
  type BatchDriver,
  type BatchHandle,
  type BatchRequest,
  type BatchResult,
  type BatchSubmitOptions,
} from "../types.js"

const MAX_REQUESTS_PER_BATCH = 100_000

const anthropicBatchObjectSchema = z
  .object({
    id: z.string(),
    processing_status: z.enum(["in_progress", "canceling", "ended"]),
    request_counts: z
      .object({
        processing: z.number(),
        succeeded: z.number(),
        errored: z.number(),
        canceled: z.number(),
        expired: z.number(),
      })
      .loose(),
    results_url: z.string().nullable().optional(),
  })
  .loose()

const anthropicResultLineSchema = z
  .object({
    custom_id: z.string(),
    result: z
      .object({
        type: batchOutcomeSchema,
        message: anthropicMessageSchema.optional(),
        error: z.object({ type: z.string(), message: z.string() }).loose().optional(),
      })
      .loose(),
  })
  .loose()

export interface AnthropicBatchDriverOptions {
  readonly apiKey: string
  readonly baseUrl?: string
  readonly fetch?: typeof fetch
}

function requireProviderId(handle: BatchHandle): string {
  const id = handle.provider.batchIds[0]
  if (!id) throw new Error(`anthropic batch handle "${handle.id}" has no provider batch id`)
  return id
}

export function anthropicBatchDriver(opts: AnthropicBatchDriverOptions): BatchDriver {
  const baseUrl = (opts.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "")
  const doFetch = opts.fetch ?? fetch

  function headers(): Record<string, string> {
    return {
      "x-api-key": opts.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    }
  }

  async function fetchBatch(providerId: string) {
    const res = await doFetch(`${baseUrl}/messages/batches/${providerId}`, { headers: headers() })
    if (!res.ok) {
      throw new Error(`anthropic batch status ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    return anthropicBatchObjectSchema.parse(await res.json())
  }

  return {
    id: "anthropic",

    async submit(
      requests: readonly BatchRequest[],
      _submitOpts?: BatchSubmitOptions,
    ): Promise<BatchHandle> {
      validateBatchRequests(requests)
      if (requests.length > MAX_REQUESTS_PER_BATCH) {
        throw new Error(
          `anthropic batch: ${requests.length} requests exceeds the ${MAX_REQUESTS_PER_BATCH} limit`,
        )
      }

      const res = await doFetch(`${baseUrl}/messages/batches`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          requests: requests.map(request => ({
            custom_id: request.customId,
            params: request.body,
          })),
        }),
      })
      if (!res.ok) {
        throw new Error(`anthropic batch submit ${res.status}: ${(await res.text()).slice(0, 200)}`)
      }
      const batch = anthropicBatchObjectSchema.parse(await res.json())

      return {
        id: newBatchId(),
        driver: "anthropic",
        provider: { batchIds: [batch.id] },
        createdAt: new Date().toISOString(),
        requestCount: requests.length,
        models: Array.from(new Set(requests.map(request => request.body.model))),
      }
    },

    async status(handle: BatchHandle) {
      const batch = await fetchBatch(requireProviderId(handle))
      return {
        state: batch.processing_status,
        counts: {
          processing: batch.request_counts.processing,
          succeeded: batch.request_counts.succeeded,
          errored: batch.request_counts.errored,
          canceled: batch.request_counts.canceled,
          expired: batch.request_counts.expired,
        },
        providerStatus: batch.processing_status,
      }
    },

    async *results(handle: BatchHandle): AsyncIterable<BatchResult> {
      const providerId = requireProviderId(handle)
      const batch = await fetchBatch(providerId)
      const resultsUrl = batch.results_url ?? `${baseUrl}/messages/batches/${providerId}/results`
      const res = await doFetch(resultsUrl, { headers: headers() })
      if (!res.ok) {
        throw new Error(`anthropic batch results ${res.status}: ${(await res.text()).slice(0, 200)}`)
      }
      const text = await res.text()
      for (const line of text.split("\n")) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        const parsed = anthropicResultLineSchema.parse(JSON.parse(trimmed))
        yield {
          customId: parsed.custom_id,
          outcome: parsed.result.type,
          message: parsed.result.message,
          error: parsed.result.error,
        }
      }
    },

    async cancel(handle: BatchHandle): Promise<void> {
      const providerId = requireProviderId(handle)
      const res = await doFetch(`${baseUrl}/messages/batches/${providerId}/cancel`, {
        method: "POST",
        headers: headers(),
      })
      if (!res.ok) {
        throw new Error(`anthropic batch cancel ${res.status}: ${(await res.text()).slice(0, 200)}`)
      }
    },
  }
}
