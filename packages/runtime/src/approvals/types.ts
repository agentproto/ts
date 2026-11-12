/**
 * Approvals — the daemon's human-approval primitive, on AIP-7 signatures.
 *
 * An `ApprovalRequest` pins an exact payload (sha256 of its canonical JSON)
 * behind a human decision. Only a declared human channel (`web_click`,
 * `ui_card`, `telegram`) may decide it — never a model-callable MCP tool.
 * An approve writes an AIP-7 `signature` on the pinned payload bytes and
 * appends a hash-chained audit event; a deny appends an audit event with no
 * signature. See `.plans/pygmalion/lanes/E1a.md` for the spec this
 * implements and AIP-7 (https://agentproto.dev/docs/aip-7) for the
 * accepted specification.
 */

export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "denied",
  "expired",
  "consumed",
] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

/** Parse a raw query/body value into an `ApprovalStatus`, or `undefined`
 *  when it isn't one — mirrors `task-ledger.ts`'s `parseTaskStatus`. */
export function parseApprovalStatus(raw: string | null | undefined): ApprovalStatus | undefined {
  return APPROVAL_STATUSES.find(s => s === raw)
}

export const APPROVAL_CHANNELS = ["web_click", "ui_card", "telegram"] as const
export type ApprovalChannel = (typeof APPROVAL_CHANNELS)[number]

export type ApprovalDecision = "approve" | "deny"

/** Who asked. A spawned session, or the operator (root `/mcp`, HTTP twins). */
export type ApprovalRequester = { sessionId: string } | { operator: true }

/** Who to re-prompt when the approval is decided: the session that opened
 *  it, or an agent label (resolved at decision time, like a cron's `agent`
 *  target, so a relaunched agent still hears the answer). */
export interface ApprovalWakeTarget {
  sessionId?: string
  agent?: string
}

/** `reach` on a request: `false` keeps the REACH router silent for this
 *  approval, an object sets the message urgency. `now` is accepted from
 *  producer code (`POST /approvals`) only, never from the model-callable
 *  `approval_request` tool. Stored on the record; ignored when the daemon
 *  has no `reach.routes`. */
export type ApprovalReachOption = false | { urgency: "now" | "normal" | "digest" }

export interface ApprovalDecisionRecord {
  decision: "approved" | "denied"
  channel: ApprovalChannel
  decidedAt: string
  /** Workspace-relative path to the AIP-7 signature.json — present only
   *  on an approve (a deny writes an audit event, never a signature). */
  signaturePath?: string
  /** The verified Telegram user id of the human who decided, when the
   *  decision came through an approval link (`POST
   *  /approvals/:id/decision/telegram` under a link-session token). Absent
   *  for every other decision, including the bot bridge's. */
  telegramUserId?: string
}

export interface ApprovalRecord {
  id: string
  kind: string
  title: string
  /** JSON-ready preview for a UI to render, supplied verbatim by the
   *  requester. Opaque to the engine. */
  preview: unknown
  /** sha256 (hex) of the canonical JSON of the payload written to
   *  `<id>/payload.json` at request time. */
  payloadHash: string
  status: ApprovalStatus
  requestedBy: ApprovalRequester
  /** Opt-in: re-prompt this session or agent when a human decides. */
  wake?: ApprovalWakeTarget
  taskId?: string
  appId?: string
  /** Human channels allowed to decide this approval. */
  channels: readonly ApprovalChannel[]
  requestedAt: string
  expiresAt?: string
  /** As requested; absent when the request did not say. */
  reach?: ApprovalReachOption
  decision?: ApprovalDecisionRecord
  consumedAt?: string
}

/** Stable error codes for `approval_consume` / the HTTP twin. */
export type ApprovalErrorCode =
  | "approval_not_found"
  | "approval_not_approved"
  | "approval_already_consumed"
  | "payload_mismatch"
  | "approval_expired"
  | "not_requester"

export class ApprovalError extends Error {
  readonly name = "ApprovalError" as const
  constructor(
    readonly code: ApprovalErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** Thrown by `decideWeb` / `decideByCard` / `decideTelegram` when the
 *  approval isn't `pending` any more — not an `ApprovalErrorCode` (that
 *  vocabulary is about consuming, not deciding); the HTTP layer maps this
 *  to 409. */
export class ApprovalNotPendingError extends Error {
  readonly name = "ApprovalNotPendingError" as const
  constructor(readonly status: ApprovalStatus) {
    super(`approval is "${status}", not pending`)
  }
}

/** One-time card ticket for the `ui_card` channel (M2 wire-up point) — only
 *  the hash is ever persisted, mirroring the Pygmalion M1 gate reference. */
export interface CardTicketRecord {
  approvalId: string
  ticketHash: string
  expiresAt: string
  usedAt?: string
}

export type CardTicketErrorCode = "missing" | "expired" | "used" | "mismatch"

export class CardTicketError extends Error {
  readonly name = "CardTicketError" as const
  constructor(
    readonly code: CardTicketErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** 10 minutes — same TTL the Pygmalion M1 gate reference uses. */
export const CARD_TICKET_TTL_MS = 10 * 60 * 1000

/** A decision a subscriber still has to deliver to the system that asked for
 *  it (the Bureau bridge's W2 relay). Persisted next to the approval record as
 *  `<id>/relay-outbox.json`, so a daemon restart or an outage on the other side
 *  does not lose the human's answer. Holds NO header values or credentials: the
 *  target comes from `payload.json` and the connection is re-resolved at send. */
export interface RelayOutboxEntry {
  approvalId: string
  decision: "approved" | "denied"
  /** Failed delivery attempts so far. */
  attempts: number
  queuedAt: string
}

/** A Telegram card the bridge has sent and not yet closed. Persisted next to
 *  the approval record as `<id>/telegram-card.json`, so a tap on a card sent
 *  before a daemon restart still decides, and a decision made while the daemon
 *  was down still strips the old message's buttons. `token` is the opaque
 *  random callback token; no bot token, chat id or user id is stored.
 *  `parseMode` says how `text` must be sent back when the card is closed; a
 *  card written before the HTML cards has none and is plain text. */
export interface TelegramCardEntry {
  token: string
  approvalId: string
  messageId: number
  text: string
  parseMode?: "HTML"
}

/** Marker that a decision reached the system that asked for it, stored as
 *  `<id>/relayed.json`. The boot sweep skips approvals that carry one. */
export interface RelayedMarker {
  approvalId: string
  relayedAt: string
}

/** One REACH attempt for an approval, kept append-only in `<id>/reach.json`.
 *  A receipt plus the key it was for and what triggered it (`route` for the
 *  `approval:requested` pass, `watchdog` for the floor). No URL, secret, chat
 *  id or user id is ever stored. */
export interface ReachReceiptEntry {
  dedupeKey: string
  adapterId: string
  kind: string
  status: "delivered" | "deferred" | "deduped" | "undelivered" | "failed"
  until?: string
  reason?: string
  at: string
  trigger: "route" | "watchdog"
}
