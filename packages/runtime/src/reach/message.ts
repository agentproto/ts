/**
 * The one REACH message for an approval, built from the record: no producer
 * writes it, and nothing in it is specific to an adapter.
 */

import { reachContentFromPreview, type ReachMessage } from "@agentproto/reach"

import type { ApprovalRecord } from "../approvals/types.js"

export const APPROVAL_ASK_OPTIONS = ["approve", "deny"] as const

export function approvalDedupeKey(approvalId: string): string {
  return `approval:${approvalId}`
}

export function buildApprovalReachMessage(record: ApprovalRecord): ReachMessage {
  const sessionId = "sessionId" in record.requestedBy ? record.requestedBy.sessionId : undefined
  return {
    ...reachContentFromPreview(record.preview, record.title),
    intent: "ask",
    to: "owner",
    urgency: record.reach ? record.reach.urgency : "normal",
    dedupeKey: approvalDedupeKey(record.id),
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
    source: {
      kind: record.kind,
      ...(record.appId ? { appId: record.appId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(record.wake?.agent ? { label: record.wake.agent } : {}),
    },
    ask: { ref: record.id, options: [...APPROVAL_ASK_OPTIONS] },
  }
}
