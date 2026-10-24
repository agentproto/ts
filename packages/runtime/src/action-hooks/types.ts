/**
 * Action hooks contract types for the AIP-71 reference implementation.
 * See https://agentproto.sh/docs/aip-71 and docs/design/action-hooks-v1.md.
 */

/**
 * An AIP-39 action id (qualified `<category>:<verb>` or unqualified). These six
 * are the runtime actions of specs/aip-39.mdx.
 */
export type ActionKind =
  | "session"
  | "session:spawn"
  | "session:prompt"
  | "session:control"
  | "session:configure"
  | "model:invoke"
  | "auth-profile:use"
  | string

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
