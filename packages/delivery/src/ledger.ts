import type { Floor, Level } from "./types.js"

/** Which producer wrote the line. */
export type LedgerProducer = "sentinel" | "follow" | "message"

/** What actually happened to the envelope at this target. */
export type LedgerOutcome =
  | "delivered"
  | "queued"
  | "inbox"
  | "retargeted"
  | "revived"
  | "parked"
  | "dropped"
  | "duplicate"

/** One append-only delivery decision. The hash chain (`prev`) is the NEXT PR;
 *  lines are not linked yet, so this file stays a plain JSONL journal. */
export interface LedgerLine {
  /** ISO timestamp, the moment the outcome was known. */
  ts: string
  producer: LedgerProducer
  subscriptionId: string
  target: { kind: "session"; id: string }
  eventId: string
  type: string
  subject: string
  eventTs?: string
  repeatKey?: string
  floor?: Floor
  level: Level
  cap: Level
  rule: string
  applied: boolean
  outcome: LedgerOutcome
  routedTo?: string
  messageId?: string
}

/** The level a triage `wake` / `fyi` / `drop` decision stands for. */
export function levelFromDecision(decision: "wake" | "fyi" | "drop"): Level {
  if (decision === "wake") return 2
  if (decision === "fyi") return 1
  return 0
}
