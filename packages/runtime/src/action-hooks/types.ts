/**
 * Action hooks contract types for the AIP-71 reference implementation.
 *
 * Spec: https://github.com/agentproto/agentproto/blob/main/specs/aip-71.mdx
 *       https://github.com/agentproto/agentproto/blob/main/specs/aip-39.mdx
 *
 * `ActionInterception` comes from the action hooks plan (section "Core model",
 * item 1) and is not an AIP-71 term.
 */

export const RUNTIME_ACTION_IDS = [
  "session:spawn",
  "session:prompt",
  "session:control",
  "session:configure",
  "model:invoke",
  "auth-profile:use",
] as const

export type RuntimeActionId = (typeof RUNTIME_ACTION_IDS)[number]

/**
 * An AIP-39 action id. The six runtime ids autocomplete; any other id must be
 * checked with `isActionKind`.
 */
export type ActionKind = RuntimeActionId | (string & {})

export type ActionInterception = "full" | "permission-only" | "observe-only" | "unavailable"
export interface ActionActor { kind: "operator" | "session" | "routine" | "system"; id: string }
export interface ActionScope { daemonId: string; workspace?: string; sessionId?: string; parentSessionId?: string }
export interface ActionEnvelope<T = unknown> {
  actionId: string          // this occurrence; distinct from the AIP-39 action id in `kind`
  kind: ActionKind
  requestedAt: string       // ISO timestamp
  actor: ActionActor
  scope: ActionScope
  input: T
  idempotencyKey?: string
  correlationId?: string
  capabilities: { interception: ActionInterception }  // derived by the host, never trusted from caller input
}
export type AdmissionDecision =
  | { outcome: "allow" }
  | { outcome: "deny"; code: string; message: string }
  | { outcome: "reuse"; targetId: string; code: string }
  | { outcome: "defer"; queueEntryId: string; retryAfterMs?: number; code: string }
export type HookOwner = "harness" | "host"
