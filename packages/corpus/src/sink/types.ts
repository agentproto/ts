/**
 * Sink — the agnostic outbound boundary: push refined corpus entries to an
 * external store. The kit knows NOTHING about any host (Guilde, etc.) — it
 * just hands `SinkItem`s to a `SinkPort`. Concrete sinks (a config-driven MCP
 * caller, an HTTP endpoint, a local mirror) live in host/adapter packages and
 * are selected by a sink manifest, not by code in the kit.
 *
 * This is how a vendor-neutral corpus links to a specific host: via a
 * declarative sink config + MCP, never a host-named command.
 */

export interface SinkItem {
  readonly slug: string
  readonly kind: string
  readonly title: string
  readonly body: string
  /** Provenance — raw source ids this entry derived from. */
  readonly sources: readonly string[]
  readonly tags: readonly string[]
  readonly confidence: number
  readonly access?: string
  /** Stable address for idempotent upsert, e.g. `corpus://<slug>`. */
  readonly uri: string
}

export interface SinkPushResult {
  readonly uri: string
  readonly ok: boolean
  readonly skipped?: boolean
  readonly error?: string
}

export interface SinkPort {
  /** Push one item. Idempotent on `uri` is the sink's responsibility. */
  push(item: SinkItem): Promise<SinkPushResult>
}
