/**
 * The batch contract: one Messages-shaped request body, submitted N at a
 * time, tracked by a driver-agnostic handle, and collected as results keyed
 * by `customId` (never by position). Batch is a delivery mode wrapped around
 * the same Anthropic Messages body — not a separate model surface.
 */

import { z } from "zod"

// ── the per-item body ───────────────────────────────────────────────────────
//
// Provider payloads cross a trust boundary, so every shape here is validated
// with zod rather than asserted — same ethos as the other raw-fetch ports in
// this repo. `.loose()` keeps fields this contract doesn't need to know about
// (the Messages API is large and still evolving).

const anthropicContentBlockSchema = z
  .object({
    type: z.string(),
    // Declared explicitly (rather than left to `.loose()`'s passthrough) so
    // callers can read a text block's `text` without an `unknown` cast — the
    // one content-block field every caller of this package needs.
    text: z.string().optional(),
  })
  .loose()

const anthropicMessageInputSchema = z
  .object({
    role: z.string(),
    content: z.union([z.string(), z.array(anthropicContentBlockSchema)]),
  })
  .loose()

const anthropicToolSchema = z
  .object({
    name: z.string(),
  })
  .loose()

const anthropicToolChoiceSchema = z
  .object({
    type: z.string(),
  })
  .loose()

/** The Anthropic Messages request body — the same shape whether it's sent
 *  synchronously or wrapped in a batch envelope. */
export const messagesBodySchema = z
  .object({
    model: z.string(),
    messages: z.array(anthropicMessageInputSchema).min(1),
    max_tokens: z.number().int(),
    system: z.union([z.string(), z.array(anthropicContentBlockSchema)]).optional(),
    tools: z.array(anthropicToolSchema).optional(),
    tool_choice: anthropicToolChoiceSchema.optional(),
    temperature: z.number().optional(),
    stream: z.boolean().optional(),
    speed: z.string().optional(),
    fallbacks: z.array(z.string()).optional(),
  })
  .loose()

export type MessagesBody = z.infer<typeof messagesBodySchema>

// ── the response message ────────────────────────────────────────────────────

const anthropicUsageSchema = z
  .object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
  })
  .loose()

/** A completed Anthropic Messages response, as returned inside a batch result. */
export const anthropicMessageSchema = z
  .object({
    content: z.array(anthropicContentBlockSchema),
    model: z.string(),
    stop_reason: z.string().nullable().optional(),
    usage: anthropicUsageSchema,
  })
  .loose()

export type AnthropicMessage = z.infer<typeof anthropicMessageSchema>

const batchResultErrorSchema = z
  .object({
    type: z.string(),
    message: z.string(),
  })
  .loose()

export type BatchResultError = z.infer<typeof batchResultErrorSchema>

// ── the envelope ─────────────────────────────────────────────────────────────
//
// These are OUR shapes (not provider payloads) — zod-first per the contract,
// but strict rather than `.loose()`: nothing external ever flows into them
// directly, so there's no unknown-field drift to absorb.

/** One item to submit: the customer-supplied id plus the Messages body. */
export const batchRequestSchema = z.object({
  customId: z.string(),
  body: messagesBodySchema,
})

export type BatchRequest = z.infer<typeof batchRequestSchema>

export const batchSubmitOptionsSchema = z.object({
  label: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
})

export type BatchSubmitOptions = z.infer<typeof batchSubmitOptionsSchema>

/** A driver-agnostic reference to a submitted batch. `id` is ours (`b_<ulid>`,
 *  see `newBatchId`), stable across process restarts; `provider.batchIds` are
 *  whatever the underlying API assigned (one driver may fan out to several). */
export const batchHandleSchema = z.object({
  id: z.string(),
  driver: z.string(),
  provider: z.object({ batchIds: z.array(z.string()) }),
  createdAt: z.string(),
  requestCount: z.number().int().nonnegative(),
  models: z.array(z.string()),
})

export type BatchHandle = z.infer<typeof batchHandleSchema>

export const batchStateSchema = z.enum(["queued", "in_progress", "canceling", "ended", "failed"])

export type BatchState = z.infer<typeof batchStateSchema>

export const batchCountsSchema = z.object({
  processing: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  errored: z.number().int().nonnegative(),
  canceled: z.number().int().nonnegative(),
  expired: z.number().int().nonnegative(),
})

export type BatchCounts = z.infer<typeof batchCountsSchema>

export const batchStatusSchema = z.object({
  state: batchStateSchema,
  counts: batchCountsSchema,
  providerStatus: z.string().optional(),
})

export type BatchStatus = z.infer<typeof batchStatusSchema>

export const batchOutcomeSchema = z.enum(["succeeded", "errored", "canceled", "expired"])

export type BatchOutcome = z.infer<typeof batchOutcomeSchema>

/** One result, keyed by `customId` — never by position; batch APIs return
 *  results in arbitrary order. */
export const batchResultSchema = z.object({
  customId: z.string(),
  outcome: batchOutcomeSchema,
  message: anthropicMessageSchema.optional(),
  error: batchResultErrorSchema.optional(),
})

export type BatchResult = z.infer<typeof batchResultSchema>

export interface BatchDriver {
  readonly id: string
  submit(requests: readonly BatchRequest[], opts?: BatchSubmitOptions): Promise<BatchHandle>
  status(handle: BatchHandle): Promise<BatchStatus>
  results(handle: BatchHandle): AsyncIterable<BatchResult>
  cancel(handle: BatchHandle): Promise<void>
}

/** Thrown by `cancel()` when a driver's provider doesn't document/support it
 *  (e.g. OpenRouter Batch) — an explicit typed failure, never a silent no-op. */
export class BatchUnsupportedError extends Error {
  constructor(
    public readonly operation: string,
    public readonly driver: string,
  ) {
    super(`${driver} does not support "${operation}"`)
    this.name = "BatchUnsupportedError"
  }
}

export class BatchValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BatchValidationError"
  }
}

// ── contract-layer rules (driver-agnostic, enforced before any submit) ──────

/** Rejects request bodies that a batch envelope cannot carry: `stream`,
 *  `speed`, `fallbacks`, `max_tokens < 1`, and a forced `tool_choice` of
 *  `any`/`tool` (400s on submit per the ground-truth doc). Errors name the
 *  offending `customId` so a caller can trace it back to its source. */
export function validateForBatch(request: BatchRequest): void {
  const { customId, body } = request
  const problems: string[] = []

  if (body.stream) problems.push('"stream" is not supported in batch requests')
  if (body.speed !== undefined) problems.push('"speed" is not supported in batch requests')
  if (body.fallbacks !== undefined) {
    problems.push('"fallbacks" is not supported in batch requests')
  }
  if (body.max_tokens < 1) problems.push("max_tokens must be >= 1")
  const toolChoiceType = body.tool_choice?.type
  if (toolChoiceType === "any" || toolChoiceType === "tool") {
    problems.push(`tool_choice.type "${toolChoiceType}" is not supported in batch requests`)
  }

  if (problems.length > 0) {
    throw new BatchValidationError(`invalid batch request "${customId}": ${problems.join("; ")}`)
  }
}

/** Rejects a submit batch containing duplicate `customId`s — results are
 *  keyed by `customId`, so a duplicate would make results ambiguous. */
export function assertUniqueCustomIds(requests: readonly BatchRequest[]): void {
  const seen = new Set<string>()
  for (const request of requests) {
    if (seen.has(request.customId)) {
      throw new BatchValidationError(`duplicate customId "${request.customId}" in batch submit`)
    }
    seen.add(request.customId)
  }
}

/** Full pre-submit validation a driver runs before talking to a provider:
 *  uniqueness across the batch, then per-request batch-compatibility. */
export function validateBatchRequests(requests: readonly BatchRequest[]): void {
  assertUniqueCustomIds(requests)
  for (const request of requests) validateForBatch(request)
}

/** `expired` is not a failure — the item never ran and should be resubmitted
 *  by the caller, not treated as an error. */
export function expiredCustomIds(results: Iterable<BatchResult>): string[] {
  const ids: string[] = []
  for (const result of results) {
    if (result.outcome === "expired") ids.push(result.customId)
  }
  return ids
}
