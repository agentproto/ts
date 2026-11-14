/**
 * Types for `resolveOperator` (AIP-9 §Resolution).
 *
 * Resolution is pure: every template the operator references is read through
 * `OperatorSources`, an injected loader. Nothing here touches a file, the
 * network or the clock.
 */

import type { AgentEntry, ModelRef } from "@agentproto/agent"
import type { IdentityHandle } from "@agentproto/identity"
import type { PersonaHandle } from "@agentproto/persona"
import type { GrantInput, PolicyGrants } from "@agentproto/policy"
import type { RoleSource } from "@agentproto/role"
import type { SkillEntry } from "@agentproto/skill"
import type { OperatorHandle } from "./types.js"

/** An operator handle with its OPERATOR.md body (the handle carries no body). */
export interface OperatorEntry {
  readonly operator: OperatorHandle
  readonly body?: string
}

export interface IdentityEntry {
  readonly identity: IdentityHandle
  readonly body?: string
}

export interface PersonaEntry {
  readonly persona: PersonaHandle
  readonly body?: string
}

/**
 * The injected loader. Each function receives the ref as written (a string
 * ref, or the `ref`/`file` of an object ref) and returns the template, or
 * `null` when the ref does not resolve. A missing function counts as `null`:
 * resolution refuses rather than leaving a referenced template out.
 */
export interface OperatorSources {
  agent?(ref: string): Promise<AgentEntry | null>
  identity?(ref: string): Promise<IdentityEntry | null>
  persona?(ref: string): Promise<PersonaEntry | null>
  skill?(ref: string): Promise<SkillEntry | null>
  policy?(ref: string): Promise<PolicyGrants | null>
  /** Consulted in order, first match wins (AIP-47). */
  readonly roles?: readonly RoleSource[]
  /** Host check for a well typed slot ref; absent = no `role_slot_unresolvable`. */
  refResolves?(ref: unknown, slot: string): boolean
  /**
   * The node-chain policies (AIP-72 / AIP-38 composition): composed with the
   * operator's own policy, so a deny anywhere on the chain wins.
   */
  readonly chainPolicies?: readonly GrantInput[]
  /** Merge step 7: host definition sections (AGENTS.md prefix, house rules), in order. */
  readonly hostSections?: readonly string[]
  /** The host default model, used when neither the operator nor its base agents name one (AIP-42 requires a model). */
  readonly defaultModel?: ModelRef
  /** Extra principals the operator is evaluated as. Always includes `operator://<id>` and `operator:<id>`. */
  readonly principals?: readonly string[]
}

export type ResolutionWarningCode =
  | "intent_unsatisfied"
  | "tool_not_evaluated"
  | "tool_scope_ignored"
  | "role_slot_unresolvable"
  | "role_extends_cycle"
  | "role_extends_missing"
  | "role_validation_failed"
  | "role_missing"
  | "role_fallback"
  | "operator_field_deprecated"

export interface ResolutionWarning {
  readonly code: ResolutionWarningCode
  readonly message: string
  /** The tool, slot or ref the warning is about, when there is one. */
  readonly subject?: string
}

export type ResolutionErrorCode =
  | "agent_unresolvable"
  | "agent_chain_too_deep"
  | "agent_chain_cycle"
  | "identity_unresolvable"
  | "persona_unresolvable"
  | "skill_unresolvable"
  | "policy_unresolvable"
  | "policy_invalid"
  | "role_unresolvable"
  | "role_chain_too_deep"
  | "role_chain_cycle"
  | "role_binding_invalid"
  | "tool_not_granted"
  | "autonomy_participation_conflict"
  | "model_missing"

export interface ResolutionIssue {
  readonly code: ResolutionErrorCode
  readonly message: string
  readonly subject?: string
}

/** Resolution refused. `issues` lists every refusal found, not only the first. */
export class OperatorResolutionError extends Error {
  readonly code: ResolutionErrorCode
  readonly issues: readonly ResolutionIssue[]

  constructor(issues: readonly ResolutionIssue[]) {
    const first = issues[0]
    super(
      `resolveOperator (AIP-9): ${first?.message ?? "refused"}${
        issues.length > 1 ? ` (+${issues.length - 1} more)` : ""
      }`,
    )
    this.name = "OperatorResolutionError"
    this.code = first?.code ?? "role_binding_invalid"
    this.issues = issues
  }
}

/** The resolved operator: an AGENT entry whose body is the composed system prompt. */
export interface ResolvedOperator extends AgentEntry {
  readonly body: string
  /** Stable sha256 hex of every input resolution read. Carried by the AIP-46 `operatorDigest`. */
  readonly digest: string
  readonly warnings: readonly ResolutionWarning[]
  /** The role's AIP-10 packs, the corpus floor the host mounts (merge step 4). */
  readonly knowledgePacks: readonly string[]
  /** Role refs walked, leaf first. Empty when the operator holds no role. */
  readonly roleChain: readonly string[]
  /** Agent ids walked, operator first. */
  readonly agentChain: readonly string[]
}

/** AIP-47 limit on the role `extends` chain. */
export const ROLE_CHAIN_MAX = 8
