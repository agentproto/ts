/**
 * Shared Langfuse ingestion transport — auth, a batch buffer, and a flush that
 * POSTs to `${baseUrl}/api/public/ingestion` with Basic auth. Both the eval
 * sink (`langfuseTelemetry`) and the agent-session tracer map their own domain
 * events into Langfuse batch items and hand them to this client; the client
 * owns nothing domain-specific — just the wire.
 */

/** Credentials + endpoint for a Langfuse ingestion client. */
export interface IngestionConfig {
  /** Langfuse public key (Basic auth username). */
  readonly publicKey: string
  /** Langfuse secret key (Basic auth password). */
  readonly secretKey: string
  /** Langfuse base URL, e.g. `https://cloud.langfuse.com`. */
  readonly baseUrl: string
  /** Optional fetch implementation (defaults to `globalThis.fetch`). */
  readonly fetchImpl?: typeof fetch
}

/** Result of a {@link IngestionClient.flush}. */
export interface FlushResult {
  /** HTTP status, or `0` when the batch was empty and no request was made. */
  readonly status: number
  /** Number of batch items actually sent. */
  readonly sent: number
  /** Parsed JSON response body (or the raw text if it wasn't JSON), `null` on an empty flush. */
  readonly body: unknown
}

/**
 * One Langfuse ingestion batch item. `id` is the batch-envelope id — Langfuse's
 * idempotency/dedup key, which MUST be a unique string per operation (a create
 * and a later update of the same object share a body id but need distinct
 * envelope ids). `body` is any JSON object (a `trace-create`, `generation-create`,
 * `span-update`, `score-create`, … payload).
 */
export interface IngestionItem {
  readonly id: string
  readonly type: string
  readonly timestamp: string
  readonly body: object
}

/** A batching Langfuse ingestion transport. */
export interface IngestionClient {
  /** Buffer one item for the next flush. */
  enqueue(item: IngestionItem): void
  /** Number of buffered items not yet flushed. */
  size(): number
  /** Drain the buffer and POST it. Atomic: items enqueued during the in-flight
   *  request stay buffered for the next flush rather than being dropped. */
  flush(): Promise<FlushResult>
}

/** Build a batching Langfuse ingestion client. */
export function createIngestionClient(cfg: IngestionConfig): IngestionClient {
  const fetchImpl = cfg.fetchImpl ?? globalThis.fetch
  const auth = `Basic ${Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString("base64")}`
  const url = `${cfg.baseUrl}/api/public/ingestion`
  const batch: IngestionItem[] = []

  return {
    enqueue(item: IngestionItem): void {
      batch.push(item)
    },
    size(): number {
      return batch.length
    },
    async flush(): Promise<FlushResult> {
      // Take the current buffer up front so anything enqueued while the POST is
      // in flight is preserved for the next flush (a naive clear-after-await
      // would drop those). Empty batch → no request.
      const items = batch.splice(0, batch.length)
      if (items.length === 0) {
        return { status: 0, sent: 0, body: null }
      }
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: auth,
        },
        body: JSON.stringify({ batch: items }),
      })
      const text = await response.text()
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
      return { status: response.status, sent: items.length, body }
    },
  }
}
