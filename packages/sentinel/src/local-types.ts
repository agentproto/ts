/**
 * Structural views of the runtime types the sentinel core consumes.
 *
 * These are deliberately minimal and local: sentinel must not import
 * `@agentproto/runtime`, and the runtime's concrete objects remain
 * assignable because these interfaces only require the fields sentinel
 * actually reads.
 */

export type MessageUrgency = "fyi" | "next-turn" | "steer" | "interrupt"
export type MessageDeliveryVia = "wait" | "steer" | "turn" | "interrupt" | "inbox"
export type MessageRelation = "child" | "parent" | "sibling" | "granted" | "human" | "system"
export type MessageKind = "report" | "question" | "blocker" | "done" | "notice"

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

export interface RetirementFields {
  archived?: boolean
  endedReason?: string
  continuedTo?: string
  retiredAt?: string
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
  emit(ev: any): void
  onAny(handler: (ev: any) => void): () => void
}
