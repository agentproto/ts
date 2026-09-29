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
  /** Stable across retries/redeliveries. Idempotency key is `(sentinelId,
   *  event.id)` — unaffected by `SentinelSpec.match` fan-out: an event that
   *  happens to satisfy more than one match clause on the same sentinel is
   *  still landed at most once. */
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

/** Where a matching event is delivered.
 *
 *  `routine` is reserved for AIP-41 `schedule.kind: event` binding; `webhook`
 *  is reserved for forwarding a matched event to an external HTTP callback.
 *  Both are FROZEN SHAPES ONLY — `SentinelStore.create` rejects them with
 *  {@link SentinelTargetNotImplementedError} until a later step wires actual
 *  delivery (design §6/§12 step 4 for `routine`; `webhook` has no design
 *  section yet). Declaring the shape now lets callers/tools reference the
 *  full union before delivery exists. */
export type SentinelTarget =
  | { kind: "session"; sessionId: string; urgency: MessageUrgency }
  | { kind: "routine"; routineId: string }
  | { kind: "webhook"; url: string; secret: string }

/** One clause of a sentinel's watch: a subject (exact, or a `*`-suffixed
 *  prefix match against an event's `subjects`) plus an optional per-clause
 *  type glob list. */
export interface SentinelMatchClause {
  /** Hierarchical routing key, e.g. "github:agentproto/ts#1428". A trailing
   *  `*` is a prefix match against an event's `subjects`. */
  subject: string
  /** Type globs; undefined = the provider's `defaultTypes(subject)`. */
  types?: string[]
}

/** Build a single-clause `match` array — the common case, and the shape
 *  every sentinel used before multi-clause fan-out existed. */
export function singleMatch(subject: string, types?: string[]): SentinelMatchClause[] {
  return [{ subject, ...(types ? { types } : {}) }]
}

/**
 * "Watch any of `match` until `condition`, deliver to `target`."
 *
 * `match` is OR semantics: an event matches the sentinel if it matches ANY
 * clause (subject + that clause's own type glob / provider default). At
 * least one clause is required — use {@link singleMatch} for a one-clause
 * spec. The event's own `subject` (not the matching clause's, which may be a
 * `*` prefix template) is what lands as `correlationId: sentinel:<subject>`
 * and the `[<scheme>]` inbox-text prefix — see `sentinel-runtime.ts`.
 *
 * Dedup key is `(sentinelId, event.id)`, same for every clause — see
 * {@link SentinelEvent.id}.
 */
export interface SentinelSpec {
  match: SentinelMatchClause[]
  until: SentinelUntil
  target: SentinelTarget
  /** Provider slug; undefined = auto-select (not implemented by the runtime
   *  yet — step 2 requires an explicit slug). */
  provider?: string
  /** Fan-out grouping — sentinels created together (e.g. several
   *  PR-related watches for one review) share a `group` id so they can be
   *  listed/removed together later. Purely descriptive: the runtime never
   *  reads it, no MCP tool consumes it yet. */
  group?: string
  /** Human-readable label surfaced by `sentinel_list` / the CLI. Purely
   *  descriptive, same as `group`. */
  label?: string
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
  | {
      mode: "push"
      /** Public daemon origin the provider should call back into. A push
       *  provider that owns its own secret/route (the `webhook` provider)
       *  ignores or derives both; absent when no public URL is known. */
      callbackUrl?: string
      secret?: string
    }

/** The delivery a runtime/tool should request from `provider`: poll when it
 *  can poll (cheap, zero infra), otherwise push. Keeps every `create`/
 *  `attach` call site from hardcoding `mode: "poll"` now that push-only
 *  providers exist. */
export function deliveryPreferenceFor(
  provider: Pick<SentinelProviderHandle, "capabilities" | "preferredDelivery">,
  intervalMs: number,
): DeliveryPreference {
  if (provider.preferredDelivery) return provider.preferredDelivery(intervalMs)
  return provider.capabilities.poll ? { mode: "poll", intervalMs } : { mode: "push" }
}

/** Extra context the runtime/tools hand to `create` beyond the spec. */
export interface SentinelCreateContext {
  /** The id the store will record this sentinel under (`sen_<ulid>`), minted
   *  BEFORE `create` so a provider that stamps it remotely (agentpush's
   *  `consumerRef`) names the same sentinel the daemon does. */
  sentinelId?: string
}

/** Whether a provider can operate right now, and if not, why. */
export interface SentinelProviderReadiness {
  ready: boolean
  /** Human-readable, actionable reason when `ready` is false. */
  reason?: string
}

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
  create(spec: SentinelSpec, delivery: DeliveryPreference, ctx?: SentinelCreateContext): Promise<SentinelHandle>
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
   *  by the `"sentinel"` dialect on `POST /inbound/sentinel-<hookKey>`). */
  parseInbound?(
    req: { rawBody: string; headers: Record<string, string | string[] | undefined> },
    handle: SentinelHandle,
  ): { ok: true; events: SentinelEvent[] } | { ok: false; reason: string }
  /** Delivery a provider that supports both modes wants by default. Absent =
   *  poll when `capabilities.poll`, else push (see {@link deliveryPreferenceFor}). */
  preferredDelivery?(intervalMs: number): DeliveryPreference
  /** Default `types` for a subject scheme when the spec leaves it undefined. */
  defaultTypes(subject: string): string[]
  /** Optional operational-readiness probe (public URL known, auth scope
   *  sufficient, ...). Consulted by `list_sentinel_adapters` and provider
   *  auto-selection. Absent = always ready. Never throws — a probe failure
   *  is `{ready:false, reason}`. */
  readiness?(): Promise<SentinelProviderReadiness>
}
