/**
 * AIP-9 OperatorDefinition + OperatorHandle.
 *
 * This is the merged AIP-9 shape. The vendored `OPERATOR.schema.json`
 * (resources/aip-9/draft/) lags it: the draft still requires `version`/`profile`
 * and carries no `role`, `home`, `reports_to` or AGENT fields, so JSON-Schema
 * consumers of OPERATOR.md should not validate against the stale draft until it
 * is re-vendored. The AGENT fields
 * (model, identity, persona, runner, tools, skills, memory, policy, autonomy,
 * boundaries, ...) are taken from `@agentproto/agent` by reference and never
 * copied: the operator only adds what an organization contributes (role, home,
 * participation, runtime, position prose) and keeps the deprecated pre-S2
 * forms readable.
 */

import type {
  AgentDefinition,
  AnyRef,
  McpToolRef,
  ToolRef as AgentToolRef,
} from "@agentproto/agent"

export type { AgentToolRef, McpToolRef }

/** AGENT fields an operator carries as-is, all optional on an operator. */
type InheritedAgentFields = Partial<
  Pick<
    AgentDefinition,
    | "version"
    | "description"
    | "extends"
    | "model"
    | "identity"
    | "persona"
    | "runner"
    | "actions"
    | "workflows"
    | "routines"
    | "delegates_to"
    | "policy"
    | "traits"
    | "autonomy"
    | "boundaries"
    | "on"
    | "publish"
    | "tags"
    | "metadata"
  >
>

/** Deprecated: an AIP-14 tool narrowed for this operator. */
export interface LegacyScopedToolRef {
  id: string
  source?: string
  scope?: {
    workspace?: string
    network?: readonly string[]
    secrets?: readonly string[]
  }
}
export type ToolRef = AgentToolRef | LegacyScopedToolRef

export type AgentSkillRef = NonNullable<AgentDefinition["skills"]>[number]
/** Deprecated: an AIP-3 skill pinned for this operator. */
export interface LegacySkillRef {
  id: string
  source?: string
  version?: string
  allow?: readonly string[]
}
export type SkillRef = AgentSkillRef | LegacySkillRef

export type MemoryKind = "none" | "thread" | "operator-context" | "external"
export type MemoryPolicy = "append-only" | "redactable" | "summarising"
/** Deprecated: the pre-S2 governance autonomy enum. */
export type Autonomy = "autonomous" | "supervised" | "gated"
export type ParticipationMode = "mention-only" | "proactive" | "silent"
export type OperatorRuntimeKind = "in-process" | "agent-cli"
export type OperatorRuntimeSessionMode = "ephemeral" | "persistent" | "resumable"

/** Deprecated memory form. `kind` maps onto the AGENT memory config. */
export interface LegacyMemory {
  kind: MemoryKind
  policy?: MemoryPolicy
  /** Operator ids granted READ access to this operator's memory. */
  share_with?: readonly string[]
  /** Required when `kind === "external"`. */
  external?: { uri: string; namespace?: string }
}
export type OperatorMemory = LegacyMemory

/** Deprecated inline governance object. */
export interface LegacyGovernance {
  policies?: readonly string[]
  audit_log: string
  autonomy: Autonomy
}
export type OperatorGovernance = LegacyGovernance

/** A value bound to a role slot: an AIP-54 ref or a tool ref. */
export type RoleSlotValue = AnyRef | AgentToolRef

/** The AIP-47 role an operator holds. A bare string is `{ ref }`. */
export interface OperatorRoleBinding {
  /** AIP-54 ref to the ROLE: a slug, `ws://roles/<slug>` or a path to a ROLE.md. */
  ref: string
  /** Slot name to value. Checked against the role's slots, not here. */
  bind?: Readonly<Record<string, RoleSlotValue>>
  /** Rare scalar parameters the role declares. */
  with?: Readonly<Record<string, string | number | boolean>>
}
export type OperatorRole = string | OperatorRoleBinding

export interface OperatorParticipation {
  /** Default `mention-only`. A gated operator (autonomy 0) is never proactive. */
  mode?: ParticipationMode
  /** Host-evaluated predicate; when true the operator emits a `pass` instead of a full turn. */
  pass_when?: string
  /** Default `false`. */
  reactions?: boolean
}

export interface OperatorRuntime {
  /** Default `in-process`. */
  kind: OperatorRuntimeKind
  /** AIP-45 HARNESS ref. Required when kind=agent-cli. */
  ref?: string
  /** Deprecated: session lifetime belongs to AIP-46 and the host. Read as a hint. */
  session?: {
    mode?: OperatorRuntimeSessionMode
    idle_timeout_ms?: number
  }
  /** Per-runtime config validated by the host against the AIP-45 manifest. */
  config?: {
    mode?: string
    options?: Readonly<Record<string, unknown>>
    continuation?: "none" | "pinned-session" | "transcript" | "native-resume"
  }
}

/** Position prose. `role` is the door-plate title, not a role ref. */
export interface OperatorProfile {
  /** Position / title prose. 1-1000 chars. */
  role?: string
  /** Deprecated: folded into an inline persona voice. */
  voice?: string
  /** Deprecated: folded into `boundaries` (union, dedupe). */
  boundaries?: readonly string[]
}

export interface OperatorDefinition extends InheritedAgentFields {
  /** Operator slug: machine identifier, dispatch slug, body of `operator:<slug>`. 2-64 chars. */
  id: string
  /** Human-readable display name. 1-80 chars. */
  name: string
  /** One-sentence role description, written for a teammate to read at a glance. 1-280 chars. */
  persona_summary: string
  /** Relative path to the implementation file (e.g. `operator.ts`). */
  entry?: string
  /** The AIP-47 role. Optional during the alias period: see `OperatorWarning`. */
  role?: OperatorRole
  /** AIP-54 ref to the AIP-34 workspace node that is the operator's home. */
  home?: AnyRef
  /** Deprecated: `home`. */
  company?: AnyRef
  /** Slug of the operator this one reports to, when no AIP-22 seat gives the line. */
  reports_to?: string
  /** AGENT `skills` items plus the deprecated pinned form. */
  skills?: readonly SkillRef[]
  /** AGENT `tools` items plus the structured MCP ref and the deprecated scoped form. */
  tools?: readonly ToolRef[]
  /** AGENT memory config, or the deprecated `{kind, policy, share_with, external}`. */
  memory?: AgentDefinition["memory"] | LegacyMemory
  /** AGENT governance ref, or the deprecated inline `{policies, audit_log, autonomy}`. */
  governance?: AgentDefinition["governance"] | LegacyGovernance
  /** Capability surface declared. Negotiated against runtime offer at registration. */
  capabilities?: readonly string[]
  participation?: OperatorParticipation
  runtime?: OperatorRuntime
  profile?: OperatorProfile
}

export type OperatorWarning =
  | {
      code: "role_fallback"
      /** Where the role was read from, because `role` is absent. */
      source: "metadata.roleSlug" | "profile.role"
      role: string
      message: string
    }
  | {
      code: "role_missing"
      message: string
    }
  | {
      code: "operator_field_deprecated"
      field: string
      message: string
    }

export interface OperatorHandle {
  readonly id: string
  readonly name: string
  readonly persona_summary: string
  readonly version?: string
  readonly description?: string
  readonly entry?: string
  /**
   * The role, normalized to `{ref, bind?, with?}`. Absent when none resolved
   * (`role_missing`): there is never a default role.
   */
  readonly role?: Readonly<OperatorRoleBinding>
  readonly home?: AnyRef
  readonly reports_to?: string
  readonly extends?: AgentDefinition["extends"]
  readonly model?: AgentDefinition["model"]
  readonly identity?: AgentDefinition["identity"]
  readonly persona?: AgentDefinition["persona"]
  readonly runner?: AgentDefinition["runner"]
  readonly actions?: AgentDefinition["actions"]
  readonly workflows?: AgentDefinition["workflows"]
  readonly routines?: AgentDefinition["routines"]
  readonly delegates_to?: AgentDefinition["delegates_to"]
  readonly policy?: AgentDefinition["policy"]
  readonly traits?: AgentDefinition["traits"]
  readonly autonomy?: number
  readonly on?: AgentDefinition["on"]
  readonly publish?: AgentDefinition["publish"]
  readonly skills: readonly SkillRef[]
  readonly tools: readonly ToolRef[]
  /** AGENT memory config (legacy `memory.kind` already mapped onto it). */
  readonly memory?: AgentDefinition["memory"]
  /** AGENT governance ref. A legacy inline governance object is kept in `legacy`. */
  readonly governance?: AgentDefinition["governance"]
  /** Union of `boundaries` and the deprecated `profile.boundaries`. */
  readonly boundaries: readonly string[]
  /** Position prose, when the operator has a `profile`. */
  readonly profile?: Readonly<{ role?: string }>
  readonly capabilities: readonly string[]
  readonly participation: Readonly<OperatorParticipation>
  readonly runtime?: Readonly<OperatorRuntime>
  readonly tags: readonly string[]
  readonly metadata: Readonly<Record<string, unknown>>
  /** Deprecated forms as written, for hosts that still honour them (alias period). */
  readonly legacy?: Readonly<{
    memory?: LegacyMemory
    governance?: LegacyGovernance
  }>
  /** Diagnostics from reading the definition: role fallback, deprecations. */
  readonly warnings: readonly OperatorWarning[]
}

export interface DefineOperatorOptions {
  /**
   * Does this slug resolve in the host's role sources? Only consulted for the
   * `profile.role` fallback, which applies solely to a value that is a role slug
   * that resolves. Absent = `profile.role` is never read as a role.
   */
  roleExists?: (slug: string) => boolean
}
