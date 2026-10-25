/**
 * Structural views of the runtime types the sentinel core consumes.
 *
 * These are deliberately minimal and local: sentinel must not import
 * `@agentproto/runtime`, and the runtime's concrete objects remain
 * assignable because these interfaces only require the fields sentinel
 * actually reads.
 */

import { randomBytes } from "node:crypto"

export function ulid(now: number = Date.now()): string {
  const time = now.toString(32).padStart(10, "0")
  const rand = randomBytes(10).toString("hex").slice(0, 16)
  return (time + rand).toUpperCase()
}

export type MessageUrgency = "fyi" | "next-turn" | "steer" | "interrupt"
export type MessageDeliveryVia = "wait" | "steer" | "turn" | "interrupt" | "inbox"
export type MessageRelation = "child" | "parent" | "sibling" | "peer" | "human" | "system"
export type MessageKind = "report" | "question" | "blocker" | "done" | "notice"

export const MESSAGE_URGENCIES: readonly MessageUrgency[] = ["fyi", "next-turn", "steer", "interrupt"]

export interface SessionMessageFrom {
  sessionId?: string
  label?: string
  role?: string
  adapter?: string
  relation: MessageRelation
}

export interface SessionMessage {
  id: string
  ts: string
  to: string
  from: SessionMessageFrom
  kind: MessageKind
  urgency: MessageUrgency
  delivered?: { via: MessageDeliveryVia; at: string; turnSeq?: number }
  correlationId?: string
  replyTo?: string
  text: string
  data?: Record<string, unknown>
  ackedAt?: string
}

export interface SendMessageResult {
  messageId: string
  delivered: { via: MessageDeliveryVia } | null
  queued: boolean
  urgencyApplied: MessageUrgency
  refused?: "inbox-full"
}

/** `RecordOpenedPrInput.adapter` for PRs merely mentioned in output. */
export const OUTPUT_SCAN_ADAPTER = "output-scan"

export interface RecordOpenedPrInput {
  adapter: string
  number: number
  url: string
}

export const DELIBERATE_END_REASONS: ReadonlySet<string> = new Set([
  "operator-completed",
  "operator-stopped",
  "steward-completed",
  "steward-abandoned",
  "restarted",
])

export interface RetirementFields {
  archived?: boolean
  endedReason?: string
  continuedTo?: string
  retiredAt?: string
}

export function isRetired(desc: Omit<RetirementFields, "endedReason"> & { endedReason?: string }): boolean {
  return (
    desc.archived === true ||
    desc.continuedTo !== undefined ||
    desc.retiredAt !== undefined ||
    (desc.endedReason !== undefined && DELIBERATE_END_REASONS.has(desc.endedReason))
  )
}

export function normalizeExpiresAt(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined
  return Number.isNaN(Date.parse(value)) ? undefined : value
}

export function isExpiresAtReached(expiresAt: string | undefined, nowMs: number): boolean {
  if (expiresAt === undefined) return false
  const ms = Date.parse(expiresAt)
  return Number.isNaN(ms) || ms <= nowMs
}

const TRIAGE_DECISIONS = ["wake", "fyi", "drop"] as const
export type TriageDecision = (typeof TRIAGE_DECISIONS)[number]

export interface PrStatusSnapshot {
  fetchedAt: string
  state: "open" | "merged" | "closed"
  reviews: Array<{ login: string; state: string; submittedAt: string }>
  checks?: Array<{ name: string; conclusion: string | null }>
  headSha?: string
  headRefName?: string
}

export interface ReviewPrRef {
  provider: "github"
  repo: string
  number: number
  url: string
}

export type GhRunner = (args: readonly string[]) => Promise<string>

export type SessionEvent =
  | {
      type: "session:turn-end"
      sessionId: string
      ts: string
      label?: string
      awaitingInput?: boolean
      question?: { text?: string; source?: string }
      reason?: string
      error?: string
    }
  | {
      type: "session:awaiting-input"
      sessionId: string
      ts: string
      label?: string
      question?: { text?: string; source?: string }
    }
  | {
      type: "session:exited"
      sessionId: string
      ts: string
      label?: string
      status?: string
      exitCode?: number
      reason?: string
    }

export interface SessionEventBus {
  emit(ev: SessionEvent): void
  onAny(handler: (ev: SessionEvent) => void): () => void
}
