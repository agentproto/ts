/**
 * AIP-9 OperatorDefinition + OperatorHandle.
 *
 * Mirrors `OPERATOR.schema.json` (resources/aip-9/draft/) one-to-one.
 * The .md frontmatter and the TS literal are interchangeable inputs
 * to `defineOperator` — same fields, same constraints, same handle
 * shape on the way out.
 */

/** AIP-3 skill reference. Plain id, or an object with optional source/version/allow. */
export type SkillRef =
  | string
  | {
      id: string
      source?: string
      version?: string
      allow?: readonly string[]
    }

/**
 * AIP-14 tool reference. Plain id, an explicit `{ id, source?, scope? }`,
 * or an MCP-server binding `{ kind: "mcp", server, allow? }`.
 */
export type ToolRef =
  | string
  | {
      id: string
      source?: string
      scope?: {
        workspace?: string
        network?: readonly string[]
        secrets?: readonly string[]
      }
    }
  | {
      kind: "mcp"
      server: string
      allow?: readonly string[]
    }

export type MemoryKind = "none" | "thread" | "operator-context" | "external"
export type MemoryPolicy = "append-only" | "redactable" | "summarising"
export type Autonomy = "autonomous" | "supervised" | "gated"
export type ParticipationMode = "mention-only" | "proactive" | "silent"

export interface OperatorProfile {
  /** Job title and primary responsibility. 1–1000 chars. */
  role: string
  /** Tone, register, pronoun stance. 1–1000 chars. */
  voice: string
  /** Imperative MUST-NOT rules. Surface in every system-prompt synthesis. */
  boundaries: readonly string[]
}

export interface OperatorMemory {
  kind: MemoryKind
  /** Default `summarising` when memory section is present. */
  policy?: MemoryPolicy
  /** Operator ids granted READ access to this operator's memory. */
  share_with?: readonly string[]
  /** Required when `kind === "external"`. */
  external?: { uri: string; namespace?: string }
}

export interface OperatorGovernance {
  /** AIP-7 policy refs (`policy:<slug>`) consulted before privileged actions. */
  policies?: readonly string[]
  /** Audit channel (`audit:<slug>`) for state transitions, tool calls, memory writes. */
  audit_log: string
  /** Per-turn autonomy class. */
  autonomy: Autonomy
}

export interface OperatorParticipation {
  /** Default `mention-only`. AIP-9 cross-field rule: autonomy=gated forces mention-only or silent. */
  mode?: ParticipationMode
  /** Host-evaluated predicate; when true the operator emits a `pass` instead of a full turn. */
  pass_when?: string
  /** Default `false`. */
  reactions?: boolean
}

export interface OperatorDefinition {
  /** Machine identifier and dispatch slug. Lowercase, digits, dashes. 2–64 chars. */
  id: string
  /** Human-readable display name. 1–80 chars. */
  name: string
  /** One-sentence role description, written for a teammate to read at a glance. 1–280 chars. */
  persona_summary: string
  /** Spec version of THIS file. Bump on breaking change. */
  version: string
  /** Relative path to the implementation file (e.g. `operator.ts`). */
  entry?: string
  profile: OperatorProfile
  /** AIP-3 skill references. */
  skills?: readonly SkillRef[]
  /** AIP-14 tool refs and MCP server bindings the operator may invoke. */
  tools?: readonly ToolRef[]
  memory?: OperatorMemory
  governance?: OperatorGovernance
  /** Capability surface declared. Negotiated against runtime offer at registration. */
  capabilities?: readonly string[]
  participation?: OperatorParticipation
  tags?: readonly string[]
  metadata?: Record<string, unknown>
}

export interface OperatorHandle {
  readonly id: string
  readonly name: string
  readonly persona_summary: string
  readonly version: string
  readonly entry?: string
  readonly profile: Readonly<{
    role: string
    voice: string
    boundaries: readonly string[]
  }>
  readonly skills: readonly SkillRef[]
  readonly tools: readonly ToolRef[]
  readonly memory?: Readonly<OperatorMemory>
  readonly governance?: Readonly<OperatorGovernance>
  readonly capabilities: readonly string[]
  readonly participation?: Readonly<OperatorParticipation>
  readonly tags: readonly string[]
  readonly metadata: Readonly<Record<string, unknown>>
}
