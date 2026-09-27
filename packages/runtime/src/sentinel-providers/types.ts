/**
 * Shared types for pluggable sentinel providers (AIP-60 §3, §4).
 *
 * The sentinel family is a `@agentproto/provider-kit` consumer, same shape as
 * the tunnel family (`remote-providers/types.ts`) and the sandbox family
 * (`sandbox-providers/types.ts`): {@link SentinelProviderHandle} extends the
 * kit's generic `AdapterHandle` (slug/name/version/description/requiresSetup/
 * check) with the sentinel-specific `capabilities` plus the create/attach/
 * cancel/status/poll/ack/parseInbound lifecycle a provider implements.
 *
 * This file is deliberately self-contained (no import from `sentinel-store.js`)
 * so the contract never depends on the store's internals — `SentinelSpec` is
 * the vocabulary a provider is handed, `sentinel-store.ts` imports it from
 * here rather than the other way around.
 */

import type { AdapterHandle, SetupField } from "@agentproto/provider-kit"
import type { MessageUrgency } from "../session-message.js"

// ── Event envelope (AIP-60 §4 — CloudEvents 1.0 profile) ────────────────

/**
 * One normalized immutable fact, emitted by a provider and landed into a
 * session's inbox. CloudEvents 1.0 structured JSON plus agentproto extension
 * attributes (`summary`, `subjects`, `terminal`, `consumerref`, `seq`).
 *
 * `type` grammar: `<scheme>.<object>.<action>` (e.g.
 * `github.pull_request.closed`). `subject` grammar: `<scheme>:<path>` (e.g.
 * `github:agentproto/ts#1428`). `subjects` is the full hierarchy, most
 * specific first — a sentinel `subject` ending in `*` prefix-matches it.
 */
export interface SentinelEvent {
  readonly specversion: "1.0"
  /** Stable across retries/redeliveries — the consumer idempotency key
   *  together with the sentinel id. */
  readonly id: string
  /** URI naming the provider instance that emitted this event. */
  readonly source: string
  readonly type: string
  /** Primary (most specific) subject this event is filed under. */
  readonly subject: string
  /** ISO-8601. */
  readonly time: string
  readonly datacontenttype: "application/json"
  /** Normalized projection, <= 32 KiB. Raw provider payloads never appear
   *  here. */
  readonly data: Record<string, unknown>
  /** One line, used verbatim as inbox text (after a `[<scheme>]` prefix). */
  readonly summary: string
  /** Full subject hierarchy, most specific first. */
  readonly subjects: readonly string[]
  /** Ends the subject's lifecycle when `spec.until.kind === "subject_terminal"`. */
  readonly terminal: boolean
  /** Opaque consumer reference the provider was asked to stamp (agentpush's
   *  `consumerRef`), when applicable. */
  readonly consumerref?: string
  /** Monotonic sequence, when the provider assigns one. */
  readonly seq?: number
}

// ── Sentinel spec (AIP-60 §2 — the primitive, defined in sentinel-store.ts) ──

/** When a sentinel stops watching. */
export type SentinelUntil =
  | { kind: "subject_terminal" }
  | { kind: "at"; ms: number }
  | { kind: "count"; n: number }
  | { kind: "never" }

/** Where a matching event is delivered. `routine` is reserved for AIP-41
 *  `schedule.kind: event` binding — not wired by the runtime yet (design
 *  §6/§12 step 4). */
export type SentinelTarget =
  | { kind: "session"; sessionId: string; urgency: MessageUrgency }
  | { kind: "routine"; routineId: string }

/** "Watch `subject` for `types` until `condition`, deliver to `target`." */
export interface SentinelSpec {
  /** Hierarchical routing key, e.g. "github:agentproto/ts#1428". A trailing
   *  `*` is a prefix match against an event's `subjects`. */
  subject: string
  /** Type globs; undefined = the provider's `defaultTypes(subject)`. */
  types?: string[]
  until: SentinelUntil
  target: SentinelTarget
  /** Provider slug; undefined = auto-select (not implemented by the runtime
   *  yet — step 2 requires an explicit slug). */
  provider?: string
}

// ── Provider contract (AIP-60 §3) ────────────────────────────────────────

/** Declared capabilities of a sentinel provider — pure metadata, surfaced in
 *  `list_sentinel_adapters`. Never carries secrets. */
export interface SentinelProviderCapabilities {
  /** Subject schemes it can watch, e.g. `["github"]`, or `["*"]`. */
  subjects: string[]
  /** Can deliver by calling back into the daemon (push ingress). */
  push: boolean
  /** Supports `poll`/`ack`. */
  poll: boolean
  /** Events survive daemon downtime (hosted queue). */
  durable: boolean
  /** Push mode requires a reachable daemon (public URL). */
  needsPublicUrl: boolean
  requiresAuth: boolean
  /** Documentation only — surfaced in `list_sentinel_adapters`. */
  typicalLatencyMs: number
}

/** Opaque provider-owned state for one sentinel. Persisted on the
 *  `Sentinel` record; round-tripped through `create`/`attach`/`cancel`. */
export interface SentinelHandle {
  provider: string
  /** Remote id — agentpush subscription id, GitHub hook id, … */
  remoteId?: string
  /** Poll cursor — agentpush seq, local-gh snapshot hash, … */
  cursor?: string
  state?: Record<string, unknown>
}

/** How the daemon wants events delivered — passed to `create`/`attach` so a
 *  provider can register a webhook (push) or just start polling. */
export type DeliveryPreference =
  | { mode: "poll"; intervalMs: number }
  | { mode: "push"; callbackUrl: string; secret: string }

/**
 * A pluggable adapter that turns a sentinel spec into a stream of
 * {@link SentinelEvent}s. Same registry/adapter-kit pattern as the tunnel and
 * sandbox provider families (`AdapterHandle` gives slug/name/version/
 * description/requiresSetup/check).
 */
export interface SentinelProviderHandle extends AdapterHandle {
  readonly capabilities: SentinelProviderCapabilities
  /** Credential fields this provider accepts via `setup_sentinel_provider`.
   *  Omit (or empty) when the provider needs no credentials. */
  readonly setupFields?: readonly SetupField[]
  /** Start watching. `delivery` tells the provider how the daemon wants
   *  events. */
  create(spec: SentinelSpec, delivery: DeliveryPreference): Promise<SentinelHandle>
  /** Re-attach after a daemon restart (re-point a callback, resume a
   *  cursor). */
  attach(handle: SentinelHandle, delivery: DeliveryPreference): Promise<SentinelHandle>
  cancel(handle: SentinelHandle): Promise<void>
  status(handle: SentinelHandle): Promise<{ ok: boolean; detail?: string; pending?: number }>
  /** Poll mode: events after `handle.cursor`, oldest first, plus the new
   *  cursor. */
  poll?(handle: SentinelHandle, limit: number): Promise<{ events: SentinelEvent[]; cursor: string }>
  ack?(handle: SentinelHandle, cursor: string): Promise<void>
  /** Push mode: verify + parse one inbound HTTP request into events (called
   *  by the `"sentinel"` dialect on `POST /inbound/sentinel/:id`). */
  parseInbound?(
    req: { rawBody: string; headers: Record<string, string | string[] | undefined> },
    handle: SentinelHandle,
  ): { ok: true; events: SentinelEvent[] } | { ok: false; reason: string }
  /** Default `types` for a subject scheme when the spec leaves it undefined. */
  defaultTypes(subject: string): string[]
}
