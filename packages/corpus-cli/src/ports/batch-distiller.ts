/**
 * BatchDistiller — a DistillPort + DistillBatchPort backed by a provider
 * Batch API (`@agentproto/batch`). Builds one BatchRequest per source (same
 * Messages body + shared prompt as AnthropicDistiller), submits them all in
 * one call, polls to completion, and maps succeeded results back through the
 * shared `parseItems`. `expired`/`errored`/`canceled` items are reported and
 * left undistilled — the existing resume ledger picks them up next run.
 *
 * `distill(input)` (the plain single-item DistillPort method) delegates to
 * `distillMany` with one entry, so a BatchDistiller still satisfies any
 * caller that only knows the non-batch `DistillPort` shape.
 */

import {
  BatchStore,
  collectResults,
  expiredCustomIds,
  pollUntilEnded,
  validateForBatch,
  type BatchDriver,
  type BatchHandle,
  type BatchRequest,
  type BatchResult,
  type BatchStatus,
} from "@agentproto/batch"
import type { DistillBatchPort, DistillInput, DistilledItem, DistillPort } from "@agentproto/corpus"
import { buildDistillPrompt, parseItems } from "./distill-prompt.js"
import type { DistillUsage } from "./usage-telemetry.js"

export interface BatchDistillerOptions {
  readonly driver: BatchDriver
  readonly store: BatchStore
  /** Default a current Claude model id. */
  readonly model?: string
  /** Max refined items to extract per source. */
  readonly maxItems?: number
  /** Output language code (e.g. "fr"). Absent → English (default). */
  readonly lang?: string
  readonly pollIntervalMs?: number
  /** Optional sink for per-item token usage (cost + Langfuse export). */
  readonly onUsage?: (usage: DistillUsage) => void
  /** Optional sink for poll progress (counts per tick). */
  readonly onProgress?: (status: BatchStatus) => void
  /** Re-attach to a batch already submitted in a prior, interrupted run —
   *  skip submit and go straight to poll/collect/write. */
  readonly batchId?: string
}

interface KeyedInput {
  readonly key: string
  readonly input: DistillInput
}

export class BatchDistiller implements DistillPort, DistillBatchPort {
  private readonly driver: BatchDriver
  private readonly store: BatchStore
  private readonly model: string
  private readonly maxItems: number
  private readonly lang: string | undefined
  private readonly pollIntervalMs: number | undefined
  private readonly onUsage: ((usage: DistillUsage) => void) | undefined
  private readonly onProgress: ((status: BatchStatus) => void) | undefined
  private readonly batchId: string | undefined

  constructor(opts: BatchDistillerOptions) {
    this.driver = opts.driver
    this.store = opts.store
    this.model = opts.model ?? "claude-sonnet-5"
    this.maxItems = opts.maxItems ?? 8
    this.lang = opts.lang
    this.pollIntervalMs = opts.pollIntervalMs
    this.onUsage = opts.onUsage
    this.onProgress = opts.onProgress
    this.batchId = opts.batchId
  }

  async distill(input: DistillInput): Promise<readonly DistilledItem[]> {
    const key = "single"
    const results = await this.distillMany([{ key, input }])
    return results.get(key) ?? []
  }

  async distillMany(
    inputs: ReadonlyArray<KeyedInput>
  ): Promise<ReadonlyMap<string, readonly DistilledItem[]>> {
    const requests: BatchRequest[] = inputs.map(({ key, input }) => ({
      customId: key,
      body: {
        model: this.model,
        max_tokens: 4096,
        messages: [
          { role: "user", content: buildDistillPrompt(input, this.maxItems, { lang: this.lang }) },
        ],
      },
    }))
    for (const request of requests) validateForBatch(request)

    const handle = await this.resolveHandle(requests)
    await pollUntilEnded(this.driver, handle, {
      ...(this.pollIntervalMs !== undefined ? { intervalMs: this.pollIntervalMs } : {}),
      onTick: status => {
        process.stderr.write(
          `  batch ${handle.id}: ${status.state} — processing ${status.counts.processing} ·` +
            ` succeeded ${status.counts.succeeded} · errored ${status.counts.errored} ·` +
            ` expired ${status.counts.expired}\n`
        )
        this.onProgress?.(status)
      },
    })

    const results = await collectResults(this.driver, handle)
    await this.store.appendResults(handle.id, Array.from(results.values()))

    const inputByKey = new Map(inputs.map(entry => [entry.key, entry.input]))
    const errored: string[] = []
    const out = new Map<string, readonly DistilledItem[]>()
    for (const result of results.values()) {
      if (result.outcome === "succeeded") {
        this.reportUsage(result, inputByKey)
        out.set(result.customId, parseItems(extractText(result)))
      } else if (result.outcome === "errored") {
        errored.push(result.customId)
      }
    }

    const expired = expiredCustomIds(results.values())
    if (expired.length > 0) {
      process.stderr.write(
        `  batch ${handle.id}: expired, left undistilled (resubmit next run): ${expired.join(", ")}\n`
      )
    }
    if (errored.length > 0) {
      process.stderr.write(
        `  batch ${handle.id}: errored, left undistilled: ${errored.join(", ")}\n`
      )
    }
    return out
  }

  private async resolveHandle(requests: readonly BatchRequest[]): Promise<BatchHandle> {
    if (this.batchId) {
      const record = await this.store.load(this.batchId)
      if (!record) throw new Error(`--batch-id ${this.batchId}: no such batch in the store`)
      return record.handle
    }
    const handle = await this.driver.submit(requests)
    await this.store.create(handle, requests)
    process.stderr.write(
      `  batch id: ${handle.id} — re-attach with --batch-id ${handle.id} if this run is interrupted\n`
    )
    return handle
  }

  private reportUsage(result: BatchResult, inputByKey: ReadonlyMap<string, DistillInput>): void {
    if (!this.onUsage || !result.message) return
    const input = inputByKey.get(result.customId)
    this.onUsage({
      model: result.message.model,
      inputTokens: result.message.usage.input_tokens,
      outputTokens: result.message.usage.output_tokens,
      label: input?.title ?? result.customId,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      billing: "batch",
      ...(result.message.usage.cache_read_input_tokens !== undefined
        ? { cacheReadInputTokens: result.message.usage.cache_read_input_tokens }
        : {}),
    })
  }
}

function extractText(result: BatchResult): string {
  for (const block of result.message?.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") return block.text
  }
  return ""
}
