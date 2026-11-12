/**
 * The REACH contract (`reach/v1`): how a host reaches its human.
 *
 * A producer hands over a {@link ReachMessage}. The host finds the route of
 * the principal named in `to` (an ordered list of adapter instances) and
 * hands the message to each adapter in turn, until one answers an
 * acknowledging {@link ReachReceipt} (`delivered`, `deferred` or `deduped`).
 * Every attempt is kept as a receipt.
 *
 * Vocabulary: a *message* goes in, an *adapter* is one way out (a kind of
 * code), a *route* is the ordered list of adapter instances for one principal
 * (configuration), a *receipt* is what an adapter answers, an *answer* is what
 * comes back from a human on an `ask`. The word "channel" is kept for AIP-7
 * channels (who may decide), never for a way out.
 */

/** Only tells, or expects an answer. */
export type ReachIntent = "tell" | "ask"

/** `now` may break quiet hours, `digest` may be grouped. `now` is set by
 *  producer code or host configuration only, never by a model-callable
 *  parameter. */
export type ReachUrgency = "now" | "normal" | "digest"

export const REACH_URGENCIES: readonly ReachUrgency[] = ["now", "normal", "digest"]

/** A principal the host knows how to reach. Only `owner` exists today. */
export type ReachPrincipal = "owner" | (string & {})

export interface ReachSection {
  title: string
  text: string
}

export interface ReachLink {
  label: string
  /** Always `https:`. */
  url: string
}

export interface ReachAttachment {
  /** A bare file name: never a path, never a separator. */
  name: string
}

/** What the human reads. The approval `preview` convention, unchanged. */
export interface ReachContent {
  /** One line, the only required field. */
  summary: string
  sections?: ReachSection[]
  links?: ReachLink[]
  attachments?: ReachAttachment[]
}

/** Where a message comes from, so an adapter can say who asks. */
export interface ReachSource {
  kind: string
  appId?: string
  sessionId?: string
  label?: string
}

/** Present on an `ask`: what the answer is for, and the options offered. */
export interface ReachAsk {
  /** An AIP-7 approval id, a permission id, a question id. */
  ref: string
  options: string[]
}

export interface ReachEnvelope {
  intent: ReachIntent
  to: ReachPrincipal
  urgency: ReachUrgency
  /** At most one human-visible message per adapter for one key. Adapters
   *  must be idempotent on it. */
  dedupeKey: string
  /** ISO timestamp after which the message is moot. */
  expiresAt?: string
  source: ReachSource
  ask?: ReachAsk
}

export type ReachMessage = ReachContent & ReachEnvelope

/** The status half of a receipt: what a receiver answers on the wire. */
export type ReachReceiptBody =
  | { status: "delivered" }
  | { status: "deferred"; until: string }
  | { status: "deduped" }
  | { status: "undelivered"; reason: string }
  | { status: "failed"; reason: string }

export type ReachReceiptStatus = ReachReceiptBody["status"]

export const REACH_RECEIPT_STATUSES: readonly ReachReceiptStatus[] = [
  "delivered",
  "deferred",
  "deduped",
  "undelivered",
  "failed",
]

/** One attempt, as the host keeps it: the body plus who answered and when. */
export type ReachReceipt = ReachReceiptBody & {
  adapterId: string
  /** ISO timestamp of the answer. */
  at: string
}

/** What an adapter can do. Declared per adapter instance, not per kind. */
export interface ReachCapabilities {
  /** Longest text it shows. */
  maxChars: number
  /** How many options it can show as actions. 0 = none. */
  actions: number
  /** Can send files. */
  files: boolean
  /** Can open a page. */
  link: boolean
  /** May hold a message (quiet hours) and answer `deferred`. */
  defers: boolean
  /** Can retire what it showed (`close`). */
  retracts: boolean
  /** Verifies who answers. */
  identity: boolean
}

/** What happened to the subject of a message, for `close`. */
export type ReachCloseOutcome = "approved" | "denied" | "expired"

/** One way out. `kind` names the code, `id` the configured instance. */
export interface ReachAdapter {
  id: string
  kind: string
  capabilities: ReachCapabilities
  /** Never throws for a refusal: a refusal is a receipt. A throw is read as
   *  `failed`. */
  send(message: ReachMessage): Promise<ReachReceipt>
  /** Retire what was shown for this key. Best effort. */
  close?(dedupeKey: string, outcome: ReachCloseOutcome): Promise<void>
}

/** What comes back from a human on an `ask`. Type only for now: the inbound
 *  path is not built yet. */
export interface ReachAnswer {
  dedupeKey: string
  option: string
  actor: { kind: string; id: string; verifiedBy: string }
}

/** A route entry for the in-process Telegram bot. */
export interface ReachTelegramRouteEntry {
  id: string
  kind: "telegram"
  /** Bot credential alias. Absent: the host's configured bot. */
  alias?: string
}

/** A route entry for a signed HTTP receiver. */
export interface ReachWebhookRouteEntry {
  id: string
  kind: "webhook"
  url: string
  /** `whsec_` secret. Never echoed, never logged. */
  secret: string
  /** Default 5000. */
  timeoutMs?: number
}

/** One adapter instance in a route. A union discriminated by `kind`, so a
 *  later kind adds a member and per-instance options (for example a
 *  `render` override) without touching the others. */
export type ReachRouteEntry = ReachTelegramRouteEntry | ReachWebhookRouteEntry

/** What the `webhook` kind posts. */
export type ReachWebhookBody =
  | { type: "message"; message: ReachMessage }
  | { type: "close"; dedupeKey: string; outcome: ReachCloseOutcome }

/** True for the statuses that end a route: someone has it. */
export function isAcknowledged(receipt: Pick<ReachReceiptBody, "status">): boolean {
  return receipt.status === "delivered" || receipt.status === "deferred" || receipt.status === "deduped"
}
