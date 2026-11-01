import type { SessionsRegistry } from "./sessions.js"
import { decideSpawnProof } from "./proof-gate.js"

export type CronCreator =
  | { kind: "operator" }
  | { kind: "system" }
  | { kind: "external"; id: string }
  | { kind: "session"; sessionId: string; proof: "proven" | "claimed" }

export function isCronCreator(value: unknown): value is CronCreator {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  if (v.kind === "operator") return true
  if (v.kind === "system") return true
  if (v.kind === "external") {
    return typeof v.id === "string"
  }
  if (v.kind === "session") {
    return typeof v.sessionId === "string" && (v.proof === "proven" || v.proof === "claimed")
  }
  return false
}

export function cronCreatorOf(input: {
  callerSessionId: string | undefined
  callerScopeOwnerId: string | undefined
  credentialSessionId: string | undefined
  registry: Pick<SessionsRegistry, "get">
}): CronCreator {
  const { callerSessionId, callerScopeOwnerId, credentialSessionId, registry } = input
  const callerId = callerScopeOwnerId ?? callerSessionId
  if (callerId === undefined) {
    return { kind: "operator" }
  }
  const descriptor = registry.get(callerId)
  const callerKnown = !!descriptor
  const callerExternal = descriptor?.kind === "external"
  const scoped = callerScopeOwnerId !== undefined
  const verdict = decideSpawnProof({
    callerSessionId: callerId,
    callerKnown,
    callerExternal,
    scoped,
    credentialSessionId,
  })
  if (verdict === "none") {
    return { kind: "operator" }
  }
  if (verdict === "external") {
    return { kind: "external", id: callerId }
  }
  if (verdict === "proven") {
    return { kind: "session", sessionId: callerId, proof: "proven" }
  }
  // claimed, mismatch, caller_unknown. A credential minted for a different
  // session collapses into `claimed` here on purpose: the field is record-only
  // today. A future enforcement step must distinguish `mismatch` (a spoofed
  // claim) from a plain claim before clamping by the creator.
  return { kind: "session", sessionId: callerId, proof: "claimed" }
}
